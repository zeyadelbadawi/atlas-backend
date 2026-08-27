/**
 * PlatformCourseOrderPaymentsService — the flat, cross-tenant
 * `/platform-course-order-payments` review surface, the Course Commerce
 * analog of `PlatformPaymentService` (P12). This is the ONLY real,
 * connected trigger for `CourseOrderPaymentApplicationService.
 * applySuccessfulPayment` in this phase — `ManualTransferProvider` has no
 * online success webhook, so a Platform Owner reviewing an uploaded proof
 * (exactly like `PlatformPaymentService.approvePayment` already does for
 * Atlas subscription billing) is the real, honest completion path for
 * Atlas Payments mode course purchases today.
 *
 * Self-review guard: a reviewer must not approve/reject a course-order
 * payment for an Academy owned by an Organization they are themselves a
 * member of — the same real backend enforcement `PlatformPaymentService.
 * loadReviewablePayment` already establishes for org-billing payments,
 * adapted here because a course-order Payment has no `organizationId`
 * column to check directly (it carries `payeeAcademyId` instead — the
 * owning Organization is resolved through the denormalized
 * `CourseOrder.organizationId`).
 *
 * `runInTenantAndUserContext(courseOrder.organizationId, reviewerId, ...)`
 * — the ACTOR's own id, matching `PlatformPaymentService.approvePayment`'s
 * identical precedent exactly, never the buyer's. `payment_reviews`'s
 * existing RLS policy requires `reviewed_by = app.current_user_id AND
 * is_platform_owner(app.current_user_id)`, so the active user context
 * for this whole transaction must genuinely be the reviewer. The
 * Enrollment/CourseOrder writes `CourseOrderPaymentApplicationService`
 * performs inside this same transaction are therefore covered by
 * dedicated, additive `is_platform_owner()`-gated RLS policies
 * (`enrollments_platform_insert`/`_update`, `course_orders_platform_update`
 * — see the RLS-fix migration's own doc comment), mirroring the exact
 * "Platform Owner needs a narrow, real, audited write path" pattern
 * `payments_platform_review_update` already established in P12 — never a
 * blanket RLS bypass.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { PaymentReviewsRepository } from '../../billing/repositories/payment-reviews.repository';
import { PaymentProofsRepository } from '../../billing/repositories/payment-proofs.repository';
import { PaymentProofStorageService } from '../../billing/storage/payment-proof-storage.service';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { CourseOrderPaymentApplicationService } from './course-order-payment-application.service';
import {
  toCourseOrderPaymentResponse,
  type CourseOrderPaymentResponse,
} from '../dto/course-order-payment.contract';
import type { ApprovePaymentDto } from '../../billing/dto/approve-payment.dto';
import type { RejectPaymentDto } from '../../billing/dto/reject-payment.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { PaymentListQueryDto } from '../../billing/dto/payment-list-query.dto';

@Injectable()
export class PlatformCourseOrderPaymentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentReviewsRepository: PaymentReviewsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentProofStorageService: PaymentProofStorageService,
    private readonly courseOrdersRepository: CourseOrdersRepository,
    private readonly courseOrderPaymentApplicationService: CourseOrderPaymentApplicationService,
  ) {}

  async getPayments(
    reviewerId: string,
    query: PaymentListQueryDto,
  ): Promise<PaginatedResult<CourseOrderPaymentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.paymentsRepository.findManyAnyOrganizationCourseOrders(tx, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map((p) => toCourseOrderPaymentResponse(p)),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getPayment(
    reviewerId: string,
    paymentId: string,
  ): Promise<CourseOrderPaymentResponse> {
    const payment = await this.tenancyContextService.runInUserContext(reviewerId, (tx) =>
      this.paymentsRepository.findByIdAnyOrganization(tx, paymentId),
    );
    if (!payment || !payment.courseOrderId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toCourseOrderPaymentResponse(payment);
  }

  async approvePayment(
    reviewerId: string,
    paymentId: string,
    payload: ApprovePaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    const { courseOrder } = await this.loadReviewablePaymentAndOrder(
      reviewerId,
      paymentId,
    );

    return this.tenancyContextService.runInTenantAndUserContext(
      courseOrder.organizationId,
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

        const reloadedOrder = await this.courseOrdersRepository.findById(
          tx,
          courseOrder.id,
        );
        const reloadedPayment = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        await this.courseOrderPaymentApplicationService.applySuccessfulPayment(
          tx,
          reloadedPayment!,
          reloadedOrder!,
        );

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toCourseOrderPaymentResponse(final!);
      },
    );
  }

  async rejectPayment(
    reviewerId: string,
    paymentId: string,
    payload: RejectPaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    const { courseOrder } = await this.loadReviewablePaymentAndOrder(
      reviewerId,
      paymentId,
    );

    return this.tenancyContextService.runInTenantAndUserContext(
      courseOrder.organizationId,
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
        await this.courseOrderPaymentApplicationService.applyFailedPayment(
          tx,
          fresh,
          'errors.payment.rejectedByReviewer',
        );

        const final = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        return toCourseOrderPaymentResponse(final!);
      },
    );
  }

  /** Streams the latest proof's bytes for ANY course-order Payment — Platform review authority, gated by `PlatformOwnerGuard` at the controller. */
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
        if (!payment || !payment.courseOrderId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        return this.paymentProofsRepository.findLatestForPayment(tx, paymentId);
      },
    );
    if (!proof) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const buffer = await this.paymentProofStorageService.getObject(proof.storageKey);
    return { buffer, mimeType: proof.mimeType, fileName: proof.fileName };
  }

  /** Loads the payment + its CourseOrder (cross-tenant, platform-review-authorized) and enforces the self-review guard — see this class's own doc comment. */
  private async loadReviewablePaymentAndOrder(
    reviewerId: string,
    paymentId: string,
  ): Promise<{ courseOrder: { id: string; organizationId: string; studentId: string } }> {
    const { payment, courseOrder } = await this.tenancyContextService.runInUserContext(
      reviewerId,
      async (tx) => {
        const p = await this.paymentsRepository.findByIdAnyOrganization(tx, paymentId);
        if (!p || !p.courseOrderId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const co = await this.courseOrdersRepository.findById(tx, p.courseOrderId);
        if (!co) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return { payment: p, courseOrder: co };
      },
    );

    if (payment.reviewStatus !== 'pending') {
      throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
    }

    const ownMembership = await this.tenancyContextService.runInUserContext(
      reviewerId,
      (tx) =>
        this.organizationMembershipsRepository.findForUserInOrganization(
          tx,
          courseOrder.organizationId,
          reviewerId,
        ),
    );
    if (ownMembership) {
      throw new ForbiddenException({
        messageKey: 'errors.payment.cannotReviewOwnOrganization',
      });
    }

    return {
      courseOrder: {
        id: courseOrder.id,
        organizationId: courseOrder.organizationId,
        studentId: courseOrder.studentId,
      },
    };
  }
}
