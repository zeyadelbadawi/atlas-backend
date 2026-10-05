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
import {
  ACADEMY_MANUAL_PROVIDER_KEY,
  ATLAS_MANUAL_PROVIDER_KEY,
} from '../../billing/dto/billing.constants';
import { AcademyPaymentMethodsRepository } from '../../billing/repositories/academy-payment-methods.repository';
import {
  academyPaymentMethodKey,
  toAcademyCheckoutMethodResponse,
} from '../../billing/utils/academy-payment-method.util';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AcademyStaffRecipientsService } from '../../communications/services/academy-staff-recipients.service';
import { ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS } from '../dto/course-commerce.constants';
import type { AcademyPaymentMethod, CourseOrder } from '@prisma/client';
import {
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
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import {
  toPaymentMethodResponse,
  type PaymentMethodCapabilitiesResponse,
  type PaymentMethodResponse,
} from '../../billing/dto/payment-method.contract';
import { CourseOrdersService } from './course-orders.service';
import { toCourseOrderPaymentResponse } from '../dto/course-order-payment.contract';
import type { CourseOrderPaymentResponse } from '../dto/course-order-payment.contract';
import type { CreateCourseOrderPaymentDto } from '../dto/create-course-order-payment.dto';
import type { SubmitCourseOrderPaymentProofDto } from '../dto/submit-course-order-payment-proof.dto';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { randomUUID } from 'node:crypto';

/**
 * Thrown from inside the payment transaction INSTEAD of the 409, which
 * the caller raises afterwards — P64 Communications C3 (plan §8 D2).
 *
 * The lazy expiry was written inside the same interactive transaction as
 * the `ConflictException` that reports it, so PostgreSQL rolled the
 * `status = 'expired'` UPDATE back with the exception and the order
 * stayed `draft`/`pending_payment` forever, its `expired` metric
 * re-counted on every later attempt. The learner-visible behaviour was
 * right (`expiresAt` is re-read and the order refused again), which is
 * why it went unnoticed — but the transition never became a FACT, so
 * there was nothing for an event to hang on.
 *
 * `QuizAttemptEngineService`'s `ExpiredAttempt` is the established
 * precedent for exactly this shape: leave the transaction cleanly,
 * commit the transition in its own transaction, then throw.
 */
class CourseOrderExpired extends Error {
  constructor(
    readonly orderId: string,
    readonly organizationId: string,
    readonly academyId: string,
    readonly courseId: string,
    readonly alreadyExpired: boolean,
  ) {
    super('course_order_expired');
  }
}

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
    private readonly metrics: LearningMetricsService,
    private readonly communicationService: CommunicationService,
    private readonly academyPaymentMethodsRepository: AcademyPaymentMethodsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly academyStaffRecipientsService: AcademyStaffRecipientsService,
  ) {}

  /**
   * The payment methods this learner may use for THEIR OWN order
   * (P64 Phase 4).
   *
   * Exists because the learner checkout has no other honest source for
   * this list. `GET /payment-methods` is the platform catalog behind
   * `ManagementSurfaceGuard` — staff only — so a learner asking it gets
   * `managementSurfaceOnly` and the checkout page renders its "not
   * available for purchase yet" state for every learner, whatever the
   * academy has configured.
   *
   * The filter below is deliberately the SAME decision `createPayment`
   * makes a few lines down, read branch for branch off
   * `paymentCollectionMode`: a method offered here is a method the
   * server will accept, and one it would refuse is never shown. Keeping
   * both in this class is what stops them drifting apart.
   *
   * Two gates, as everywhere a learner addresses a row by id:
   * `findOrderOrThrow` filters on `studentId` AND the read runs in the
   * caller's own context, so `course_orders` RLS has to agree
   * independently. A misconfigured academy yields an empty list, never
   * an error — "no methods" is a real answer the page already renders.
   *
   * Payability is NOT re-decided here. `createPayment` owns the order
   * state machine and reports expiry//`notPayable` with its own precise
   * messages; duplicating that here would give the same truth two
   * places to disagree.
   */
  async listAvailableMethods(
    studentId: string,
    orderId: string,
  ): Promise<PaymentMethodResponse[]> {
    return this.tenancyContextService.runInUserContext(studentId, async (tx) => {
      const order = await this.courseOrdersService.findOrderOrThrow(
        tx,
        studentId,
        orderId,
      );

      // Academy Manual Payments — an academy with its own enabled methods
      // takes its learners' payments itself, whatever the organization's
      // collection mode (the same decision `createPayment` makes first).
      const academyMethods =
        await this.academyPaymentMethodsRepository.findEnabledForAcademy(
          tx,
          order.academyId,
        );
      if (academyMethods.length > 0) {
        return academyMethods.map(toAcademyCheckoutMethodResponse);
      }

      const settings = await this.organizationPaymentSettingsService.getPaymentSettings(
        order.organizationId,
      );

      if (settings.paymentCollectionMode === 'unconfigured') {
        return [];
      }

      if (settings.paymentCollectionMode === 'atlas_payments') {
        // Atlas Payments is not usable until an effective commission
        // resolves — `createPayment` refuses with
        // `commissionNotConfigured`, so offering a method here would be
        // offering one that cannot be paid.
        const resolution =
          await this.commissionService.resolveEffectiveCommissionInOrganizationContext(
            order.organizationId,
          );
        if (!resolution.resolved) return [];
        const methods = await this.paymentMethodsRepository.findAllEnabledByProvider(
          ATLAS_MANUAL_PROVIDER_KEY,
        );
        return methods.map(toPaymentMethodResponse);
      }

      // organization_gateway — only a verified, enabled credential whose
      // adapter actually resolves can take money, exactly as below.
      const credential =
        await this.organizationGatewayCredentialsRepository.findForResponse(
          tx,
          order.organizationId,
        );
      if (!credential || credential.status !== 'verified' || !credential.enabled) {
        return [];
      }
      if (!this.paymentProviderRegistry.tryResolve(credential.providerKey)) {
        return [];
      }
      const methods = await this.paymentMethodsRepository.findAllEnabledByProvider(
        credential.providerKey,
      );
      return methods.map(toPaymentMethodResponse);
    });
  }

  async createPayment(
    studentId: string,
    orderId: string,
    payload: CreateCourseOrderPaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    try {
      return await this.createPaymentInTransaction(studentId, orderId, payload);
    } catch (error) {
      // The lazy expiry, finished OUTSIDE the transaction it was detected
      // in — see `CourseOrderExpired`. The 409 the learner sees is
      // unchanged; what changes is that the transition now commits and
      // the learner is told about it once.
      if (error instanceof CourseOrderExpired) {
        await this.finishExpiry(studentId, error);
        throw new ConflictException({ messageKey: 'errors.courseOrder.expired' });
      }
      throw error;
    }
  }

  /**
   * Marks the order `expired`, counts it once, and tells the learner —
   * in its OWN transaction, so none of it is rolled back by the 409 that
   * follows. Idempotent: the conditional UPDATE and the catalogue dedupe
   * key both mean a second refused attempt changes nothing and says
   * nothing.
   */
  private async finishExpiry(
    studentId: string,
    signal: CourseOrderExpired,
  ): Promise<void> {
    if (signal.alreadyExpired) return;
    const emitted = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const flipped = await tx.courseOrder.updateMany({
          where: {
            id: signal.orderId,
            status: { notIn: ['expired', 'paid', 'refunded'] },
          },
          data: { status: 'expired' },
        });
        // Zero rows means another request expired it first: no second
        // metric, no second notification.
        if (flipped.count === 0) return { created: false, outboxId: null } as EmitResult;
        this.metrics.recordCheckoutOrderState('expired');
        const course = await tx.course.findUnique({
          where: { id: signal.courseId },
          select: { title: true },
        });
        return this.communicationService.emit(tx, {
          key: 'course.order.expired',
          recipientUserId: studentId,
          organizationId: signal.organizationId,
          academyId: signal.academyId,
          entity: { type: 'course_order', id: signal.orderId },
          values: { courseId: signal.courseId, courseTitle: course?.title ?? '' },
        });
      },
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
  }

  private async createPaymentInTransaction(
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

      // Academy Manual Payments — decided first, exactly as
      // `listAvailableMethods` decides it: an academy with its own enabled
      // methods takes the payment itself. That path checks the order's
      // state and expiry under the order lock, after the review check, so a
      // proof waiting for review is answered "under review" and never turns
      // its order `expired`.
      const academyMethods =
        await this.academyPaymentMethodsRepository.findEnabledForAcademy(
          tx,
          order.academyId,
        );
      if (academyMethods.length > 0) {
        return this.createAcademyManualPayment(
          tx,
          studentId,
          order,
          academyMethods,
          payload.methodKey,
        );
      }

      if (order.status === 'expired' || order.expiresAt.getTime() < Date.now()) {
        throw new CourseOrderExpired(
          order.id,
          order.organizationId,
          order.academyId,
          order.courseId,
          order.status === 'expired',
        );
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
          await this.commissionService.resolveEffectiveCommissionInOrganizationContext(
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
        this.metrics.recordCheckoutOrderState('pending_payment');
      }

      const withRelations = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        created.id,
      );
      return toCourseOrderPaymentResponse(withRelations!);
    });
  }

  /**
   * Academy Manual Payments — a payment to the academy itself, with one of
   * its own manual methods. Inside the caller's (learner's) transaction:
   *
   *   - the order row is LOCKED first, so two tabs or a double click cannot
   *     open two payments for one order; its state is re-read under the lock;
   *   - one payment waiting for review blocks another (409
   *     `paymentUnderReview`): the learner waits for that decision;
   *   - an open payment for the same method with the same details and no
   *     proof yet is returned as is (idempotent "choose method"); any other
   *     open, proof-less payment is cancelled, so at most one is open;
   *   - the amount and currency come from the order's frozen snapshot, never
   *     the request; the method's details are frozen onto the payment
   *     (`instructions_snapshot`);
   *   - no Atlas commission and no ledger entry: the money never passes
   *     through Atlas (`payment_collection_mode_snapshot = 'academy_manual'`);
   *   - the order stays payable for `ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS`,
   *     long enough to make a transfer outside Atlas.
   */
  private async createAcademyManualPayment(
    tx: Prisma.TransactionClient,
    studentId: string,
    order: CourseOrder,
    academyMethods: readonly AcademyPaymentMethod[],
    methodKey: string,
  ): Promise<CourseOrderPaymentResponse> {
    await tx.$queryRaw`SELECT "id" FROM "course_orders" WHERE "id" = ${order.id} FOR UPDATE`;
    const locked = await this.courseOrdersService.findOrderOrThrow(
      tx,
      studentId,
      order.id,
    );
    if (
      locked.status === 'paid' ||
      locked.status === 'cancelled' ||
      locked.status === 'refunded'
    ) {
      throw new ConflictException({ messageKey: 'errors.courseOrder.notPayable' });
    }

    const open = await tx.payment.findMany({
      where: {
        courseOrderId: locked.id,
        status: {
          in: [
            ...NON_TERMINAL_PAYMENT_STATUSES,
          ] as Prisma.EnumPaymentLifecycleStatusFilter['in'],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (open.some((payment) => payment.reviewStatus === 'pending')) {
      throw new ConflictException({
        messageKey: 'errors.courseOrder.paymentUnderReview',
      });
    }

    // Expiry, as for every order — checked only once nothing is under review.
    if (locked.status === 'expired' || locked.expiresAt.getTime() < Date.now()) {
      throw new CourseOrderExpired(
        locked.id,
        locked.organizationId,
        locked.academyId,
        locked.courseId,
        locked.status === 'expired',
      );
    }

    const method = academyMethods.find(
      (candidate) => academyPaymentMethodKey(candidate.type) === methodKey,
    );
    if (!method) {
      throw new NotFoundException({ messageKey: 'errors.payment.methodNotFound' });
    }

    const sameDetails = (payment: (typeof open)[number]) =>
      payment.provider === ACADEMY_MANUAL_PROVIDER_KEY &&
      payment.academyPaymentMethodId === method.id &&
      JSON.stringify(payment.instructionsSnapshot) ===
        JSON.stringify(method.instructions);
    const reusable = open.find(
      (payment) => payment.reviewStatus === 'not_required' && sameDetails(payment),
    );
    const toCancel = open.filter((payment) => payment !== reusable);
    if (toCancel.length > 0) {
      await tx.payment.updateMany({
        where: { id: { in: toCancel.map((payment) => payment.id) } },
        data: { status: 'cancelled', nextAction: Prisma.JsonNull },
      });
    }

    const windowEnd = new Date(
      Date.now() + ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS * 3_600_000,
    );
    await tx.courseOrder.update({
      where: { id: locked.id },
      data: {
        ...(locked.status === 'draft' ? { status: 'pending_payment' } : {}),
        ...(locked.expiresAt < windowEnd ? { expiresAt: windowEnd } : {}),
      },
    });
    if (locked.status === 'draft') {
      this.metrics.recordCheckoutOrderState('pending_payment');
    }

    if (reusable) {
      const existing = await this.paymentsRepository.findByIdAnyOrganization(
        tx,
        reusable.id,
      );
      return toCourseOrderPaymentResponse(existing!);
    }

    const snapshot = locked.snapshot as {
      price: { amountMinorUnits: number; currency: string };
    };
    const created = await this.paymentsRepository.createCourseOrderPayment(tx, {
      courseOrderId: locked.id,
      payerUserId: studentId,
      payeeAcademyId: locked.academyId,
      methodKey: academyPaymentMethodKey(method.type),
      methodType: method.type,
      provider: ACADEMY_MANUAL_PROVIDER_KEY,
      academyPaymentMethodId: method.id,
      amountMinorUnits: BigInt(snapshot.price.amountMinorUnits),
      currency: snapshot.price.currency,
      status: 'pending',
      reviewStatus: 'not_required',
      nextAction: { type: 'awaiting_proof' },
      instructionsSnapshot: method.instructions as Prisma.InputJsonValue,
      paymentCollectionModeSnapshot: 'academy_manual',
      commissionRateBasisPointsSnapshot: null,
      commissionAmountMinorUnits: null,
    });
    await this.paymentAttemptsRepository.create(tx, {
      payment: { connect: { id: created.id } },
      status: 'initiated',
    });

    const withRelations = await this.paymentsRepository.findByIdAnyOrganization(
      tx,
      created.id,
    );
    return toCourseOrderPaymentResponse(withRelations!);
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
    const { buffer } = parseDataUrl(payload.fileData, MAX_PAYMENT_PROOF_FILE_SIZE);
    const kind = detectFileKind(buffer);
    if (!kind || !ALLOWED_PAYMENT_PROOF_MIME_TYPES.includes(kind.mimeType)) {
      throw new ConflictException({
        messageKey: 'errors.payment.unsupportedProofFileType',
      });
    }

    let emitted: EmitResult = { created: false, outboxId: null };
    const ownerOutboxIds: string[] = [];
    const response = await this.tenancyContextService.runInUserContext(
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
        if (!NON_TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
          throw new ConflictException({ messageKey: 'errors.payment.notEditable' });
        }

        const isAcademyManual = payment.provider === ACADEMY_MANUAL_PROVIDER_KEY;
        if (isAcademyManual) {
          // One proof per review: once the academy is reviewing it, the
          // learner waits for the decision (a rejection lets them start a
          // new payment).
          if (payment.reviewStatus === 'pending') {
            throw new ConflictException({
              messageKey: 'errors.payment.alreadyUnderReview',
            });
          }
        } else {
          const method = await this.paymentMethodsRepository.findByKey(payment.methodKey);
          const capabilities = method?.capabilities as unknown as
            { supportsProof: boolean } | undefined;
          if (!capabilities?.supportsProof) {
            throw new ConflictException({
              messageKey: 'errors.payment.proofNotSupported',
            });
          }
        }

        const id = randomUUID();
        const storageKey = buildCourseOrderPaymentProofStorageKey(
          order.academyId,
          paymentId,
          kind.extension,
          id,
        );
        await this.paymentProofStorageService.putObject(
          storageKey,
          buffer,
          kind.mimeType,
        );

        await this.paymentProofsRepository.create(tx, {
          id,
          payment: { connect: { id: paymentId } },
          fileName: sanitizeFileName(payload.fileName),
          storageKey,
          mimeType: kind.mimeType,
          note: payload.note,
          payerReference: payload.payerReference?.trim() || null,
        });

        await this.paymentsRepository.update(tx, paymentId, {
          reviewStatus: 'pending',
          nextAction: { type: 'awaiting_manual_review' },
        });

        // P64 Communications C3 (plan §8 D3, §10: "proof submitted →
        // **always** (receipt) to learner"). The learner had no confirmation
        // at all that the file they uploaded had arrived — the next thing
        // they heard was the approval or the rejection, days later. The
        // receipt is written in the SAME transaction as the proof row and
        // the `awaiting_manual_review` flip, so a rolled-back submission
        // promises nothing.
        const snapshot = order.snapshot as { course?: { title?: string } } | null;
        emitted = await this.communicationService.emit(tx, {
          key: 'course.order.proof_submitted',
          recipientUserId: studentId,
          organizationId: order.organizationId,
          academyId: order.academyId,
          entity: { type: 'payment_proof', id },
          values: {
            courseTitle: snapshot?.course?.title ?? '',
            amount: (Number(payment.amountMinorUnits) / 100).toFixed(2),
            currency: payment.currency,
          },
        });

        if (isAcademyManual) {
          await this.auditLogWriterService.write(tx, {
            actorUserId: studentId,
            organizationId: order.organizationId,
            academyId: order.academyId,
            role: 'student',
            action: 'academy.course_payment.proof_submitted',
            targetType: 'payment',
            targetId: paymentId,
            context: {
              proofId: id,
              mimeType: kind.mimeType,
              methodType: payment.methodType,
            },
          });
          // The Client Owner is the reviewer: tell them there is work.
          const owners = await this.academyStaffRecipientsService.organizationOwners(
            tx,
            order.academyId,
          );
          const learner = await tx.user.findUnique({
            where: { id: studentId },
            select: { name: true },
          });
          for (const ownerId of owners) {
            const notified = await this.communicationService.emit(tx, {
              key: 'academy.payment.submitted',
              recipientUserId: ownerId,
              organizationId: order.organizationId,
              academyId: order.academyId,
              entity: { type: 'payment_proof', id },
              values: {
                academyId: order.academyId,
                paymentId,
                courseTitle: snapshot?.course?.title ?? '',
                amount: (Number(payment.amountMinorUnits) / 100).toFixed(2),
                currency: payment.currency,
                methodType: payment.methodType,
                learnerName: learner?.name ?? '',
              },
            });
            if (notified.outboxId) ownerOutboxIds.push(notified.outboxId);
          }
        }

        const withRelations = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toCourseOrderPaymentResponse(withRelations!);
      },
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    for (const outboxId of ownerOutboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }
    return response;
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
