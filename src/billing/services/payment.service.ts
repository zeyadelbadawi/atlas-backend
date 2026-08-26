/**
 * PaymentService — `organizations/:id/payments`, `/payment-methods`,
 * `organizations/:id/invoices`. Matches `PaymentService` (atlas frontend)
 * exactly: `getPaymentMethods`/`createPayment`/`getPayments`/`getPayment`/
 * `submitProof`/`cancelPayment`/`createPaymentIntent`/`getInvoices`.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other service
 * in this codebase's "never trust the guard's own read" discipline.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CheckoutsRepository } from '../repositories/checkouts.repository';
import { PaymentsRepository } from '../repositories/payments.repository';
import { PaymentAttemptsRepository } from '../repositories/payment-attempts.repository';
import { PaymentProofsRepository } from '../repositories/payment-proofs.repository';
import { PaymentMethodsRepository } from '../repositories/payment-methods.repository';
import { TenantInvoicesRepository } from '../repositories/tenant-invoices.repository';
import { PaymentProofStorageService } from '../storage/payment-proof-storage.service';
import { buildPaymentProofStorageKey } from '../utils/payment-proof-key.util';
import {
  assertWithinSizeLimit,
  detectFileKind,
  parseDataUrl,
  sanitizeFileName,
} from '../../media/utils/file-validation.util';
import {
  ALLOWED_PAYMENT_PROOF_MIME_TYPES,
  MAX_PAYMENT_PROOF_FILE_SIZE,
} from '../dto/billing.constants';
import { toPaymentMethodResponse } from '../dto/payment-method.contract';
import type {
  PaymentMethodCapabilitiesResponse,
  PaymentMethodResponse,
} from '../dto/payment-method.contract';
import { toPaymentResponse } from '../dto/payment.contract';
import type { PaymentResponse } from '../dto/payment.contract';
import { toTenantInvoiceResponse } from '../dto/tenant-invoice.contract';
import type { TenantInvoiceResponse } from '../dto/tenant-invoice.contract';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import { AtlasSubscriptionPaymentProviderService } from './atlas-subscription-payment-provider.service';
import { toPaymentIntentResponse } from '../dto/payment-intent.contract';
import type { PaymentIntentResponse } from '../dto/payment-intent.contract';
import type { CreatePaymentDto } from '../dto/create-payment.dto';
import type { SubmitPaymentProofDto } from '../dto/submit-payment-proof.dto';
import type { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CheckoutSnapshotResponse } from '../dto/checkout.contract';

const NON_TERMINAL_PAYMENT_STATUSES = new Set([
  'created',
  'pending',
  'processing',
  'requires_action',
  'requires_confirmation',
]);

@Injectable()
export class PaymentService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly checkoutsRepository: CheckoutsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentAttemptsRepository: PaymentAttemptsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentMethodsRepository: PaymentMethodsRepository,
    private readonly tenantInvoicesRepository: TenantInvoicesRepository,
    private readonly paymentProofStorageService: PaymentProofStorageService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly atlasSubscriptionPaymentProviderService: AtlasSubscriptionPaymentProviderService,
  ) {}

  /** Catalog-scoped, not organization-scoped — matches `getPaymentMethods`'s own doc comment. */
  async getPaymentMethods(): Promise<PaymentMethodResponse[]> {
    const methods = await this.paymentMethodsRepository.findAllEnabled();
    return methods.map(toPaymentMethodResponse);
  }

  async createPayment(
    organizationId: string,
    payload: CreatePaymentDto,
  ): Promise<PaymentResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const checkout = await this.checkoutsRepository.findById(
        tx,
        organizationId,
        payload.checkoutId,
      );
      if (!checkout) throw new NotFoundException({ messageKey: 'errors.notFound' });

      if (checkout.status === 'expired' || checkout.expiresAt.getTime() < Date.now()) {
        if (checkout.status !== 'expired') {
          await this.checkoutsRepository.updateStatus(tx, checkout.id, 'expired');
        }
        throw new ConflictException({ messageKey: 'errors.checkout.expired' });
      }
      if (checkout.status === 'completed' || checkout.status === 'cancelled') {
        throw new ConflictException({ messageKey: 'errors.checkout.notPayable' });
      }

      const method = await this.paymentMethodsRepository.findByKey(payload.methodKey);
      if (!method || !method.enabled) {
        throw new NotFoundException({ messageKey: 'errors.payment.methodNotFound' });
      }

      const snapshot = checkout.snapshot as unknown as CheckoutSnapshotResponse;
      const capabilities =
        method.capabilities as unknown as PaymentMethodCapabilitiesResponse;
      // Resolved via the registry, not an inline capability check — the
      // exact behavior is unchanged (ManualTransferProvider's
      // `buildInitialNextAction` is byte-for-byte the ternary this used to
      // be), but `PaymentService` now depends on the provider-abstraction
      // interface rather than branching on capabilities itself (ADR-010,
      // 2026-08-26 update).
      const provider = this.paymentProviderRegistry.resolveOrThrow(method.provider);
      const initialNextAction = provider.buildInitialNextAction(capabilities);

      const created = await this.paymentsRepository.create(tx, {
        checkout: { connect: { id: checkout.id } },
        organization: { connect: { id: organizationId } },
        methodKey: method.key,
        methodType: method.type,
        provider: method.provider,
        amountMinorUnits: BigInt(snapshot.price.amountMinorUnits),
        currency: snapshot.price.currency,
        status: 'pending',
        reviewStatus: 'not_required',
        nextAction:
          (initialNextAction as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
      });

      await this.paymentAttemptsRepository.create(tx, {
        payment: { connect: { id: created.id } },
        status: 'initiated',
      });

      if (checkout.status === 'draft') {
        await this.checkoutsRepository.updateStatus(tx, checkout.id, 'pending_payment');
      }

      const withRelations = await this.paymentsRepository.findById(
        tx,
        organizationId,
        created.id,
      );
      return toPaymentResponse(withRelations!);
    });
  }

  async getPayments(
    organizationId: string,
    query: PaymentListQueryDto,
  ): Promise<PaginatedResult<PaymentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.paymentsRepository.findManyForOrganization(tx, organizationId, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map((p) => toPaymentResponse(p)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getPayment(organizationId: string, paymentId: string): Promise<PaymentResponse> {
    const payment = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.paymentsRepository.findById(tx, organizationId, paymentId),
    );
    if (!payment) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toPaymentResponse(payment);
  }

  async submitProof(
    organizationId: string,
    paymentId: string,
    payload: SubmitPaymentProofDto,
  ): Promise<PaymentResponse> {
    const { buffer } = parseDataUrl(payload.fileData);
    assertWithinSizeLimit(buffer, MAX_PAYMENT_PROOF_FILE_SIZE);
    const kind = detectFileKind(buffer);
    if (!kind || !ALLOWED_PAYMENT_PROOF_MIME_TYPES.includes(kind.mimeType)) {
      throw new BadRequestException({
        messageKey: 'errors.payment.unsupportedProofFileType',
      });
    }

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const payment = await this.paymentsRepository.findById(
        tx,
        organizationId,
        paymentId,
      );
      if (!payment) throw new NotFoundException({ messageKey: 'errors.notFound' });
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
      const storageKey = buildPaymentProofStorageKey(
        organizationId,
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

      const withRelations = await this.paymentsRepository.findById(
        tx,
        organizationId,
        paymentId,
      );
      return toPaymentResponse(withRelations!);
    });
  }

  async cancelPayment(
    organizationId: string,
    paymentId: string,
  ): Promise<PaymentResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const payment = await this.paymentsRepository.findById(
        tx,
        organizationId,
        paymentId,
      );
      if (!payment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (!NON_TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
        throw new ConflictException({ messageKey: 'errors.payment.notEditable' });
      }

      const method = await this.paymentMethodsRepository.findByKey(payment.methodKey);
      const capabilities = method?.capabilities as unknown as
        { supportsCancellation: boolean } | undefined;
      if (!capabilities?.supportsCancellation) {
        throw new ConflictException({
          messageKey: 'errors.payment.cancellationNotSupported',
        });
      }

      await this.paymentsRepository.update(tx, paymentId, {
        status: 'cancelled',
        nextAction: Prisma.JsonNull,
      });

      const withRelations = await this.paymentsRepository.findById(
        tx,
        organizationId,
        paymentId,
      );
      return toPaymentResponse(withRelations!);
    });
  }

  /**
   * Gateway-ready contract (frontend `PaymentService.createPaymentIntent`)
   * — real and callable, resolved through the provider abstraction
   * (`AtlasSubscriptionPaymentProviderService.resolveEffectiveProviderForPaymentIntent`,
   * 2026-08-26 Atlas Subscription Payment readiness) rather than a
   * hardcoded rejection. Genuinely honest about there being no connected
   * gateway today — `ManualTransferProvider` has no payment-intent
   * capability, and no real gateway is configured, so this throws the
   * exact same `errors.payment.gatewayNotConnected` P12 always has, now
   * reached via a real resolution path instead of an unconditional throw
   * (zero behavior change; matches P11's Cloudflare "honest not-configured"
   * rule). Never a fabricated `checkoutUrl`.
   */
  async createPaymentIntent(
    organizationId: string,
    checkoutId: string,
  ): Promise<PaymentIntentResponse> {
    const checkout = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.checkoutsRepository.findById(tx, organizationId, checkoutId),
    );
    if (!checkout) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const resolution =
      await this.atlasSubscriptionPaymentProviderService.resolveEffectiveProviderForPaymentIntent();
    if (!resolution) {
      throw new ConflictException({ messageKey: 'errors.payment.gatewayNotConnected' });
    }

    const snapshot = checkout.snapshot as unknown as CheckoutSnapshotResponse;
    const clientReference = randomUUID();
    const result = await resolution.adapter.createPaymentIntent!(
      {
        checkoutId: checkout.id,
        organizationId,
        amountMinorUnits: BigInt(snapshot.price.amountMinorUnits),
        currency: snapshot.price.currency,
        clientReference,
      },
      resolution.config,
    );
    return toPaymentIntentResponse(
      checkout,
      resolution.adapter.providerKey,
      clientReference,
      result,
    );
  }

  async getInvoices(
    organizationId: string,
    query: PaymentListQueryDto,
  ): Promise<PaginatedResult<TenantInvoiceResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.tenantInvoicesRepository.findManyForOrganization(tx, organizationId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toTenantInvoiceResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** Streams the latest proof's bytes for an organization's own Payment — see `PaymentProofDownloadController`. */
  async getProofFile(
    organizationId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const proof = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const payment = await this.paymentsRepository.findById(
          tx,
          organizationId,
          paymentId,
        );
        if (!payment) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return this.paymentProofsRepository.findLatestForPayment(tx, paymentId);
      },
    );
    if (!proof) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const buffer = await this.paymentProofStorageService.getObject(proof.storageKey);
    return { buffer, mimeType: proof.mimeType, fileName: proof.fileName };
  }
}
