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
import type { EmitResult } from '../../communications/services/communication.service';
import { toPaymentResponse } from '../dto/payment.contract';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PlatformPaymentListQueryDto } from '../dto/payment-list-query.dto';
import {
  toPlatformPaymentDetailResponse,
  toPlatformPaymentListItemResponse,
  type PlatformPaymentDetailResponse,
  type PlatformPaymentListItemResponse,
} from '../dto/platform-payment-list.contract';
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
    query: PlatformPaymentListQueryDto,
  ): Promise<PaginatedResult<PlatformPaymentListItemResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.paymentsRepository.findManyAnyOrganization(tx, {
          search: query.search,
          reviewStatus: query.reviewStatus,
          status: query.status,
          methodType: query.methodType,
          from: query.from,
          to: query.to,
          sortBy: query.sortBy,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      // List rows never carry the manual-transfer instructions or the
      // proof's note — see `platform-payment-list.contract.ts`.
      items: items.map((p) => toPlatformPaymentListItemResponse(p)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getPayment(
    reviewerId: string,
    paymentId: string,
  ): Promise<PlatformPaymentDetailResponse> {
    const payment = await this.tenancyContextService.runInUserContext(reviewerId, (tx) =>
      this.paymentsRepository.findByIdAnyOrganizationWithSubscriptionContext(
        tx,
        paymentId,
      ),
    );
    // A Course Commerce (P13) row has no `organizationId` — see
    // `loadReviewablePayment`'s identical guard and doc comment above.
    if (!payment || payment.organizationId == null) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toPlatformPaymentDetailResponse(payment);
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
        // The claim comes first and is conditional: only one approval (or
        // rejection) of a pending payment can ever match, so a double click
        // or two reviewers can never apply a subscription twice.
        if (
          !(await this.paymentsRepository.claimPendingReview(
            tx,
            paymentId,
            'approved',
            payload.notes,
          ))
        ) {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'approved',
          reviewer: { connect: { id: reviewerId } },
          notes: payload.notes,
        });

        const reloaded = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        // The subscription receipt (`lifecycle.subscription.activated`)
        // is emitted inside the shared apply step, so manual approval and
        // a gateway webhook produce the same receipt exactly once — see
        // `SubscriptionReceiptService`.
        const applied = await this.paymentApplicationService.applySuccessfulPayment(
          tx,
          reloaded!,
        );
        activated = applied.receipt;

        // W8 — record the gift in the tenant's activity log when THIS
        // approval granted it (the subscription names this payment).
        const gifted = await tx.tenantSubscription.findUnique({
          where: { organizationId: payment.organizationId },
          select: {
            giftedDays: true,
            giftedEndsAt: true,
            giftedPaymentId: true,
            billingCycle: true,
            plan: { select: { key: true } },
          },
        });
        if (
          gifted?.giftedPaymentId === paymentId &&
          gifted.giftedDays &&
          gifted.giftedEndsAt
        ) {
          await this.auditLogWriterService.write(tx, {
            actorUserId: reviewerId,
            organizationId: payment.organizationId,
            action: 'subscription.gift.granted',
            targetType: 'tenant_subscription',
            targetId: payment.organizationId,
            context: {
              planKey: gifted.plan.key,
              billingCycle: gifted.billingCycle,
              giftedDays: gifted.giftedDays,
              giftedEndsAt: gifted.giftedEndsAt.toISOString(),
              paymentId,
            },
          });
        }

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
        if (
          !(await this.paymentsRepository.claimPendingReview(
            tx,
            paymentId,
            'rejected',
            payload.notes,
          ))
        ) {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'rejected',
          reviewer: { connect: { id: reviewerId } },
          notes: payload.notes,
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
