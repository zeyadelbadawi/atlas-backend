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
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';
import { toPaymentResponse } from '../dto/payment.contract';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import type { ApprovePaymentDto } from '../dto/approve-payment.dto';
import type { RejectPaymentDto } from '../dto/reject-payment.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';

@Injectable()
export class PlatformPaymentService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentReviewsRepository: PaymentReviewsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentProofStorageService: PaymentProofStorageService,
    private readonly paymentApplicationService: PaymentApplicationService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly notificationFanoutService: NotificationFanoutService,
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

    let notifiedNew = false;
    let recipientUserId: string | null = null;
    let notifiedAmountValues: { amount: number; currency: string } | null = null;
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
          recipientUserId = organization.ownerUserId;
          notifiedAmountValues = {
            amount: this.toDisplayAmount(fresh.amountMinorUnits),
            currency: fresh.currency,
          };
          notifiedNew = await this.notificationFanoutService.notify(tx, {
            userId: organization.ownerUserId,
            type: 'billing',
            priority: 'medium',
            titleKey: 'notifications:events.platformPaymentApproved.title',
            messageKey: 'notifications:events.platformPaymentApproved.message',
            values: notifiedAmountValues,
            dedupeKey: `payment_approved:${paymentId}`,
          });
        }

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toPaymentResponse(final!);
      },
    );

    if (recipientUserId && notifiedAmountValues) {
      await this.notificationFanoutService.sendEmailAfterCommit(
        recipientUserId,
        notifiedNew,
        {
          template: 'platform_payment_approved',
          values: notifiedAmountValues,
        },
      );
    }

    return result;
  }

  async rejectPayment(
    reviewerId: string,
    paymentId: string,
    payload: RejectPaymentDto,
  ): Promise<PaymentResponse> {
    const payment = await this.loadReviewablePayment(reviewerId, paymentId);

    let notifiedNew = false;
    let recipientUserId: string | null = null;
    let notifiedValues: { amount: number; currency: string; reason?: string } | null =
      null;
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
          recipientUserId = organization.ownerUserId;
          notifiedValues = {
            amount: this.toDisplayAmount(fresh.amountMinorUnits),
            currency: fresh.currency,
            reason: payload.notes,
          };
          notifiedNew = await this.notificationFanoutService.notify(tx, {
            userId: organization.ownerUserId,
            type: 'billing',
            priority: 'high',
            titleKey: 'notifications:events.platformPaymentRejected.title',
            messageKey: 'notifications:events.platformPaymentRejected.message',
            values: notifiedValues,
            dedupeKey: `payment_rejected:${paymentId}`,
          });
        }

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toPaymentResponse(final!);
      },
    );

    if (recipientUserId && notifiedValues) {
      await this.notificationFanoutService.sendEmailAfterCommit(
        recipientUserId,
        notifiedNew,
        {
          template: 'platform_payment_rejected',
          values: notifiedValues,
        },
      );
    }

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
