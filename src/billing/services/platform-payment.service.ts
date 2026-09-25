/**
 * PlatformPaymentService — the flat, cross-tenant `/payments` review
 * surface (master plan §10: "Payments (Platform review) | /payments
 * (flat) | role"). Matches `PlatformPaymentService` (atlas frontend)
 * exactly: `getPayments`/`getPayment`/`approvePayment`/`rejectPayment`.
 *
 * Read methods run under `TenancyContextService.runInUserContext` — RLS's
 * `payments_platform_review_select`/`_platform_review_select` policies
 * (paired with `is_platform_owner`, see the P12 migration's RLS header
 * comment) are the actual authority that makes a cross-tenant row visible
 * at all; `PlatformOwnerGuard` (unmodified, reused verbatim) already
 * proved the caller's `is_platform_owner` flag before any of these run —
 * same "guard proves it once, RLS proves it again independently"
 * discipline every other service in this codebase already follows.
 *
 * `approvePayment`/`rejectPayment` enforce the ONE real backend
 * requirement the frontend's own architecture doc states explicitly:
 * "Backend MUST reject a reviewer approving/rejecting their own
 * organization's payment — the frontend guard is UX only" (`Reports/
 * ARCHITECTURE.md`, Prompt 7, Backend Contract #6). The frontend's finer
 * `platform.payment.approve`/`reject` PERMISSION strings have no backend
 * enforcement counterpart in this phase — master plan §9/§24: no
 * Role/Permission catalog exists anywhere in P0–P11, and inventing one
 * here would be exactly the "generic policy-engine RBAC system the
 * frontend has no [backend] contract for" §9 forbids. `PlatformOwnerGuard`
 * (role-level) is the same authorization boundary every other Platform
 * Owner route in this codebase already uses (`PlatformDomainController`'s
 * `PATCH` gate, P11).
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { PaymentsRepository } from '../repositories/payments.repository';
import { PaymentReviewsRepository } from '../repositories/payment-reviews.repository';
import { PaymentProofsRepository } from '../repositories/payment-proofs.repository';
import { PaymentProofStorageService } from '../storage/payment-proof-storage.service';
import { PaymentApplicationService } from './payment-application.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import { resolveSubscriptionLimits } from '../../plans/utils/granted-limits.util';
import type { EmitResult } from '../../communications/services/communication.service';
import { toPaymentResponse } from '../dto/payment.contract';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import type { ApprovePaymentDto } from '../dto/approve-payment.dto';
import type { RejectPaymentDto } from '../dto/reject-payment.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';

@Injectable()
export class PlatformPaymentService {
  constructor(
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentReviewsRepository: PaymentReviewsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentProofStorageService: PaymentProofStorageService,
    private readonly paymentApplicationService: PaymentApplicationService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
  ) {}

  async getPayments(
    reviewerId: string,
    query: PaymentListQueryDto,
  ): Promise<PaginatedResult<PaymentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.paymentsRepository.findManyAnyOrganization(tx, {
          search: query.search,
          reviewStatus: query.reviewStatus,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map((p) => toPaymentResponse(p)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getPayment(reviewerId: string, paymentId: string): Promise<PaymentResponse> {
    const payment = await this.tenancyContextService.runInUserContext(reviewerId, (tx) =>
      this.paymentsRepository.findByIdAnyOrganization(tx, paymentId),
    );
    // A Course Commerce (P13) row has no `organizationId` — see
    // `loadReviewablePayment`'s identical guard and doc comment above.
    if (!payment || payment.organizationId == null) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toPaymentResponse(payment);
  }

  async approvePayment(
    reviewerId: string,
    paymentId: string,
    payload: ApprovePaymentDto,
  ): Promise<PaymentResponse> {
    const payment = await this.loadReviewablePayment(reviewerId, paymentId);

    let emitted: EmitResult = { created: false, outboxId: null };
    let activated: EmitResult = { created: false, outboxId: null };
    const result = await this.tenancyContextService.runInTenantAndUserContext(
      payment.organizationId,
      reviewerId,
      async (tx) => {
        const fresh = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        if (!fresh) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (fresh.reviewStatus !== 'pending') {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'approved',
          reviewer: { connect: { id: reviewerId } },
          notes: payload.notes,
        });
        await this.paymentsRepository.update(tx, paymentId, {
          reviewStatus: 'approved',
          reviewNotes: payload.notes,
        });

        const reloaded = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        await this.paymentApplicationService.applySuccessfulPayment(tx, reloaded!);

        // Phase P15 retroactive audit coverage — same transaction as the
        // review/payment/subscription writes above.
        await this.auditLogWriterService.write(tx, {
          actorUserId: reviewerId,
          organizationId: payment.organizationId,
          action: 'payment.approved',
          targetType: 'payment',
          targetId: paymentId,
        });

        // Phase P17 — notify the paying Organization's owner, same
        // transaction as the state change above.
        const organization = await this.organizationsRepository.findByIdAnyOrganization(
          tx,
          payment.organizationId,
        );
        if (organization) {
          emitted = await this.communicationService.emit(tx, {
            key: 'platform.payment.approved',
            recipientUserId: organization.ownerUserId,
            organizationId: payment.organizationId,
            entity: { type: 'payment', id: paymentId },
            values: {
              amount: this.toDisplayAmount(fresh.amountMinorUnits),
              currency: fresh.currency,
            },
          });

          /*
            P64 C5, §27 S1 — "Subscription started / plan changed | on
            approval (exists) — ADD a receipt with period dates and frozen
            limits". Beside the approval notice above, not instead of it:
            one says the money was accepted, this one says what the
            customer now has and until when, which is the fact they come
            back to look up.

            Only for a plan purchase — an add-on approval changes no
            subscription period and must not claim to. `applyCommercialEffect`
            has already run, so the row read here is the post-purchase one.

            The dedupe anchor is the NEW `currentPeriodEnd`: each renewal
            legitimately deserves its own receipt (§19's "events that
            legitimately repeat carry a version"), and a retried approval
            of the same payment re-derives the identical anchor and is
            rejected.
          */
          activated = await this.emitSubscriptionActivated(
            tx,
            payment.organizationId,
            organization.ownerUserId,
            fresh.checkoutId,
          );
        }

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toPaymentResponse(final!);
      },
    );

    /*
      AFTER COMMIT, never inside the transaction. An approved payment can
      turn a tenant from not-serving to serving, and the public runtime
      caches that answer for a minute. Clearing it inside the transaction
      would open a window where a concurrent public request re-populates
      the cache by reading the PRE-COMMIT state — re-caching "expired" for
      a full TTL on a tenant who has just paid, which is precisely the
      customer least willing to wait.
    */
    await this.publicWebsiteCacheService.invalidateServingEligibility(
      payment.organizationId,
    );

    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    await this.communicationService.enqueueAfterCommit(activated.outboxId);

    return result;
  }

  async rejectPayment(
    reviewerId: string,
    paymentId: string,
    payload: RejectPaymentDto,
  ): Promise<PaymentResponse> {
    const payment = await this.loadReviewablePayment(reviewerId, paymentId);

    let emitted: EmitResult = { created: false, outboxId: null };
    const result = await this.tenancyContextService.runInTenantAndUserContext(
      payment.organizationId,
      reviewerId,
      async (tx) => {
        const fresh = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        if (!fresh) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (fresh.reviewStatus !== 'pending') {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'rejected',
          reviewer: { connect: { id: reviewerId } },
          notes: payload.notes,
        });
        await this.paymentsRepository.update(tx, paymentId, {
          reviewStatus: 'rejected',
          reviewNotes: payload.notes,
        });
        await this.paymentApplicationService.applyFailedPayment(
          tx,
          fresh,
          'errors.payment.rejectedByReviewer',
        );

        // Phase P15 retroactive audit coverage.
        await this.auditLogWriterService.write(tx, {
          actorUserId: reviewerId,
          organizationId: payment.organizationId,
          action: 'payment.rejected',
          targetType: 'payment',
          targetId: paymentId,
          context: payload.notes ? { notes: payload.notes } : undefined,
        });

        // Phase P17 — notify the paying Organization's owner.
        const organization = await this.organizationsRepository.findByIdAnyOrganization(
          tx,
          payment.organizationId,
        );
        if (organization) {
          emitted = await this.communicationService.emit(tx, {
            key: 'platform.payment.rejected',
            recipientUserId: organization.ownerUserId,
            organizationId: payment.organizationId,
            entity: { type: 'payment', id: paymentId },
            values: {
              amount: this.toDisplayAmount(fresh.amountMinorUnits),
              currency: fresh.currency,
              reason: payload.notes,
            },
          });
        }

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toPaymentResponse(final!);
      },
    );

    await this.communicationService.enqueueAfterCommit(emitted.outboxId);

    return result;
  }

  /**
   * §27 S1 — the subscription receipt, emitted inside the approval's own
   * transaction.
   *
   * Returns a no-op result (and writes nothing) unless this payment was
   * for a PLAN and the subscription now has a real period: an add-on
   * approval, or a subscription row the purchase somehow left undated,
   * must not produce a receipt claiming dates it does not have.
   *
   * The limits are read from `granted_limits` through
   * `resolveSubscriptionLimits` — the one function that answers "what is
   * this customer entitled to" — so the receipt can never quote a number
   * the write gate would not honour.
   */
  private async emitSubscriptionActivated(
    tx: Prisma.TransactionClient,
    organizationId: string,
    ownerUserId: string,
    checkoutId: string | null,
  ): Promise<EmitResult> {
    const none: EmitResult = { created: false, outboxId: null };
    if (!checkoutId) return none;

    const checkout = await tx.checkout.findUnique({
      where: { id: checkoutId },
      select: { targetType: true },
    });
    if (checkout?.targetType !== 'plan_subscription') return none;

    const subscription = await tx.tenantSubscription.findUnique({
      where: { organizationId },
      select: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
        grantedLimits: true,
        plan: { select: { name: true, limits: true } },
      },
    });
    if (!subscription?.currentPeriodEnd || !subscription.currentPeriodStart) return none;

    const limits = resolveSubscriptionLimits(subscription);
    return this.communicationService.emit(tx, {
      key: 'lifecycle.subscription.activated',
      recipientUserId: ownerUserId,
      organizationId,
      entity: { type: 'tenant_subscription', id: organizationId },
      values: {
        anchorAt: subscription.currentPeriodEnd.toISOString(),
        planName: subscription.plan.name,
        periodStartDate: formatLifecycleInstant(subscription.currentPeriodStart),
        periodEndDate: formatLifecycleInstant(subscription.currentPeriodEnd),
        academiesLimit: String(limits.academies ?? ''),
        studentsLimit: String(limits.students ?? ''),
        coursesLimit: String(limits.courses ?? ''),
      },
    });
  }

  /** Minor units → display decimal, the same 2-decimal-exponent convention `toMinorUnits` (`money.util.ts`) already established for the reverse direction — used only for notification/email display text here, never a business calculation. */
  private toDisplayAmount(amountMinorUnits: bigint): number {
    return Number(amountMinorUnits) / 100;
  }

  /** Streams the latest proof's bytes for ANY organization's Payment — Platform review authority, gated by `PlatformOwnerGuard` at the controller. */
  async getProofFile(
    reviewerId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const proof = await this.tenancyContextService.runInUserContext(
      reviewerId,
      async (tx) => {
        const payment = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
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

  /** Loads the payment (cross-tenant, platform-review-authorized) and enforces the self-review guard — real backend enforcement, not the frontend's UX-only check. */
  private async loadReviewablePayment(
    reviewerId: string,
    paymentId: string,
  ): Promise<{ organizationId: string }> {
    const payment = await this.tenancyContextService.runInUserContext(reviewerId, (tx) =>
      this.paymentsRepository.findByIdAnyOrganization(tx, paymentId),
    );
    if (!payment) throw new NotFoundException({ messageKey: 'errors.notFound' });
    // A Course Commerce (P13) row has no `organizationId` at all (it
    // carries `payerUserId`/`payeeAcademyId` instead, per §5.7's
    // extension point) — this service manages Atlas-subscription-billing
    // review only. Reviewing a course-order payment is a genuinely
    // separate, structurally distinct flow, handled exclusively by
    // `PlatformCourseOrderPaymentsService`/`/platform-course-order-payments`
    // — never silently accepted here.
    if (payment.organizationId == null) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    if (payment.reviewStatus !== 'pending') {
      throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
    }

    const ownMembership = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.organizationMembershipsRepository.findForUserInOrganization(
          tx,
          payment.organizationId!,
          reviewerId,
        ),
    );
    if (ownMembership) {
      throw new ForbiddenException({
        messageKey: 'errors.payment.cannotReviewOwnOrganization',
      });
    }

    return { organizationId: payment.organizationId };
  }
}
