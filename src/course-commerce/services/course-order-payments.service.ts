/**
 * CourseOrderPaymentsService — `course-orders/:id/payments*`, buyer-scoped.
 * The Course Commerce analog of `PaymentService`'s create/list/get/proof
 * surface (P12), reusing the SAME `PaymentProviderAdapter`/
 * `PaymentProviderRegistry`/`payment_methods` catalog/proof-upload
 * validation — no second payment engine (this phase's explicit
 * instruction).
 *
 * The one genuinely new piece of logic: resolving WHICH provider/mode
 * applies is driven by the order's Organization's `payment_collection_mode`
 * (§4.1), not by a client-chosen provider —
 *
 *   - `unconfigured` → refused (§4.1's "no silent default," re-checked
 *     here as defense-in-depth even though `CourseOrdersService` already
 *     checked it at order-creation time — the Organization's configuration
 *     could have changed in between).
 *   - `atlas_payments` → resolves through the SAME `payment_methods`
 *     catalog / `ManualTransferProvider` P12's own Atlas-subscription
 *     billing already uses (reused verbatim, not reimplemented) — the
 *     effective §4.2 commission is resolved and FROZEN onto the Payment
 *     row at this exact moment, never recomputed later.
 *   - `organization_gateway` → resolves the Organization's own configured
 *     gateway; today this always ends in an honest "not configured/
 *     verified" failure, because no real gateway adapter is registered yet
 *     (§4.1/§11.x) — matching every other "seam ready, no gateway
 *     connected" precedent in this codebase (P11 Cloudflare, P12
 *     `createPaymentIntent`). No Atlas commission is ever computed for
 *     this mode — Atlas is structurally never a party to this money flow.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { PaymentAttemptsRepository } from '../../billing/repositories/payment-attempts.repository';
import { PaymentProofsRepository } from '../../billing/repositories/payment-proofs.repository';
import { PaymentMethodsRepository } from '../../billing/repositories/payment-methods.repository';
import { OrganizationPaymentSettingsService } from '../../billing/services/organization-payment-settings.service';
import { OrganizationGatewayCredentialsRepository } from '../../billing/repositories/organization-gateway-credentials.repository';
import { CommissionService } from '../../billing/services/commission.service';
import { PaymentProviderRegistry } from '../../billing/providers/payment-provider.registry';
import { PaymentProofStorageService } from '../../billing/storage/payment-proof-storage.service';
import { ATLAS_MANUAL_PROVIDER_KEY } from '../../billing/dto/billing.constants';
import {
  assertWithinSizeLimit,
  detectFileKind,
  parseDataUrl,
  sanitizeFileName,
} from '../../media/utils/file-validation.util';
import {
  ALLOWED_PAYMENT_PROOF_MIME_TYPES,
  MAX_PAYMENT_PROOF_FILE_SIZE,
} from '../../billing/dto/billing.constants';
import { buildCourseOrderPaymentProofStorageKey } from '../../billing/utils/payment-proof-key.util';
import { applyBasisPoints } from '../../billing/utils/commission-math.util';
import type { PaymentMethodCapabilitiesResponse } from '../../billing/dto/payment-method.contract';
import { CourseOrdersService } from './course-orders.service';
import { toCourseOrderPaymentResponse } from '../dto/course-order-payment.contract';
import type { CourseOrderPaymentResponse } from '../dto/course-order-payment.contract';
import type { CreateCourseOrderPaymentDto } from '../dto/create-course-order-payment.dto';
import type { SubmitCourseOrderPaymentProofDto } from '../dto/submit-course-order-payment-proof.dto';
import { randomUUID } from 'node:crypto';

const NON_TERMINAL_PAYMENT_STATUSES = new Set([
  'created',
  'pending',
  'processing',
  'requires_action',
  'requires_confirmation',
]);

@Injectable()
export class CourseOrderPaymentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly courseOrdersService: CourseOrdersService,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentAttemptsRepository: PaymentAttemptsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly organizationPaymentSettingsService: OrganizationPaymentSettingsService,
    private readonly organizationGatewayCredentialsRepository: OrganizationGatewayCredentialsRepository,
    private readonly commissionService: CommissionService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly paymentProofStorageService: PaymentProofStorageService,
  ) {}

  async createPayment(
    studentId: string,
    orderId: string,
    payload: CreateCourseOrderPaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const order = await this.courseOrdersService.findOrderOrThrow(
        tx,
        studentId,
        orderId,
      );

      if (order.status === 'expired' || order.expiresAt.getTime() < Date.now()) {
        if (order.status !== 'expired') {
          await tx.courseOrder.update({
            where: { id: order.id },
            data: { status: 'expired' },
          });
        }
        throw new ConflictException({ messageKey: 'errors.courseOrder.expired' });
      }
      if (
        order.status === 'paid' ||
        order.status === 'cancelled' ||
        order.status === 'refunded'
      ) {
        throw new ConflictException({ messageKey: 'errors.courseOrder.notPayable' });
      }

      const method = await this.paymentMethodsRepository.findByKey(payload.methodKey);
      if (!method || !method.enabled) {
        throw new NotFoundException({ messageKey: 'errors.payment.methodNotFound' });
      }

      const settings = await this.organizationPaymentSettingsService.getPaymentSettings(
        order.organizationId,
      );

      let providerKey: string;
      let commissionSnapshot: {
        readonly rateBasisPoints: number | null;
        readonly amountMinorUnits: bigint | null;
      } = { rateBasisPoints: null, amountMinorUnits: null };

      if (settings.paymentCollectionMode === 'unconfigured') {
        throw new ConflictException({
          messageKey: 'errors.courseOrder.paymentSetupIncomplete',
        });
      } else if (settings.paymentCollectionMode === 'atlas_payments') {
        // Reuses Atlas's OWN `payment_methods` catalog/provider — the same
        // one P12 Atlas-subscription billing resolves against — never a
        // second, course-commerce-specific catalog.
        if (method.provider !== ATLAS_MANUAL_PROVIDER_KEY) {
          throw new ConflictException({
            messageKey: 'errors.payment.methodNotFound',
          });
        }
        providerKey = method.provider;

        const resolution =
          await this.commissionService.resolveEffectiveCommissionForOrganization(
            tx,
            order.organizationId,
          );
        if (!resolution.resolved) {
          // §4.2's explicit rule: Atlas Payments is not usable for an
          // Organization until an effective commission rate resolves —
          // never a silent 0% guess.
          throw new ConflictException({
            messageKey: 'errors.courseOrder.commissionNotConfigured',
          });
        }
        const amountMinorUnits = BigInt(
          (order.snapshot as { price: { amountMinorUnits: number } }).price
            .amountMinorUnits,
        );
        commissionSnapshot = {
          rateBasisPoints: resolution.basisPoints,
          amountMinorUnits: applyBasisPoints(amountMinorUnits, resolution.basisPoints),
        };
      } else {
        // organization_gateway — see this class's own doc comment for why
        // this path always ends honestly here today.
        const credential =
          await this.organizationGatewayCredentialsRepository.findForResponse(
            tx,
            order.organizationId,
          );
        if (!credential || credential.status !== 'verified' || !credential.enabled) {
          throw new ConflictException({
            messageKey: 'errors.courseOrder.gatewayNotConfigured',
          });
        }
        const adapter = this.paymentProviderRegistry.tryResolve(credential.providerKey);
        if (!adapter) {
          throw new ConflictException({
            messageKey: 'errors.payment.gatewayNotConnected',
          });
        }
        providerKey = credential.providerKey;
        // No Atlas commission ever applies here — Atlas is not a party to
        // this money flow (commissionSnapshot stays null/null, its
        // initial value).
      }

      const capabilities =
        method.capabilities as unknown as PaymentMethodCapabilitiesResponse;
      const provider = this.paymentProviderRegistry.tryResolve(providerKey);
      const initialNextAction = provider?.buildInitialNextAction(capabilities) ?? null;

      const snapshot = order.snapshot as {
        price: { amountMinorUnits: number; currency: string };
      };

      const created = await this.paymentsRepository.createCourseOrderPayment(tx, {
        courseOrderId: order.id,
        payerUserId: studentId,
        payeeAcademyId: order.academyId,
        methodKey: method.key,
        methodType: method.type,
        provider: providerKey,
        amountMinorUnits: BigInt(snapshot.price.amountMinorUnits),
        currency: snapshot.price.currency,
        status: 'pending',
        reviewStatus: 'not_required',
        nextAction:
          (initialNextAction as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        paymentCollectionModeSnapshot: settings.paymentCollectionMode,
        commissionRateBasisPointsSnapshot: commissionSnapshot.rateBasisPoints,
        commissionAmountMinorUnits: commissionSnapshot.amountMinorUnits,
      });

      await this.paymentAttemptsRepository.create(tx, {
        payment: { connect: { id: created.id } },
        status: 'initiated',
      });

      if (order.status === 'draft') {
        await tx.courseOrder.update({
          where: { id: order.id },
          data: { status: 'pending_payment' },
        });
      }

      const withRelations = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        created.id,
      );
      return toCourseOrderPaymentResponse(withRelations!);
    });
  }

  async getPayment(
    studentId: string,
    orderId: string,
    paymentId: string,
  ): Promise<CourseOrderPaymentResponse> {
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      await this.courseOrdersService.findOrderOrThrow(tx, studentId, orderId);
      const payment = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        paymentId,
      );
      if (
        !payment ||
        payment.courseOrderId !== orderId ||
        payment.payerUserId !== studentId
      ) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      return toCourseOrderPaymentResponse(payment);
    });
  }

  async submitProof(
    studentId: string,
    orderId: string,
    paymentId: string,
    payload: SubmitCourseOrderPaymentProofDto,
  ): Promise<CourseOrderPaymentResponse> {
    const { buffer } = parseDataUrl(payload.fileData);
    assertWithinSizeLimit(buffer, MAX_PAYMENT_PROOF_FILE_SIZE);
    const kind = detectFileKind(buffer);
    if (!kind || !ALLOWED_PAYMENT_PROOF_MIME_TYPES.includes(kind.mimeType)) {
      throw new ConflictException({
        messageKey: 'errors.payment.unsupportedProofFileType',
      });
    }

    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const order = await this.courseOrdersService.findOrderOrThrow(
        tx,
        studentId,
        orderId,
      );
      const payment = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        paymentId,
      );
      if (
        !payment ||
        payment.courseOrderId !== order.id ||
        payment.payerUserId !== studentId
      ) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      if (!NON_TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
        throw new ConflictException({ messageKey: 'errors.payment.notEditable' });
      }

      const method = await this.paymentMethodsRepository.findByKey(payment.methodKey);
      const capabilities = method?.capabilities as unknown as
        { supportsProof: boolean } | undefined;
      if (!capabilities?.supportsProof) {
        throw new ConflictException({ messageKey: 'errors.payment.proofNotSupported' });
      }

      const id = randomUUID();
      const storageKey = buildCourseOrderPaymentProofStorageKey(
        order.academyId,
        paymentId,
        kind.extension,
        id,
      );
      await this.paymentProofStorageService.putObject(storageKey, buffer, kind.mimeType);

      await this.paymentProofsRepository.create(tx, {
        id,
        payment: { connect: { id: paymentId } },
        fileName: sanitizeFileName(payload.fileName),
        storageKey,
        mimeType: kind.mimeType,
        note: payload.note,
      });

      await this.paymentsRepository.update(tx, paymentId, {
        reviewStatus: 'pending',
        nextAction: { type: 'awaiting_manual_review' },
      });

      const withRelations = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        paymentId,
      );
      return toCourseOrderPaymentResponse(withRelations!);
    });
  }

  /** Streams the latest proof's bytes for the current buyer's own course-order Payment — see `PaymentService.getProofFile`'s identical precedent. */
  async getProofFile(
    studentId: string,
    orderId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const proof = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const order = await this.courseOrdersService.findOrderOrThrow(
          tx,
          studentId,
          orderId,
        );
        const payment = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        if (
          !payment ||
          payment.courseOrderId !== order.id ||
          payment.payerUserId !== studentId
        ) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        return this.paymentProofsRepository.findLatestForPayment(tx, paymentId);
      },
    );
    if (!proof) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const buffer = await this.paymentProofStorageService.getObject(proof.storageKey);
    return { buffer, mimeType: proof.mimeType, fileName: proof.fileName };
  }
}
