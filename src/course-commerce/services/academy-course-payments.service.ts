/**
 * AcademyCoursePaymentsService — `academies/:id/course-payments*`, the
 * Client Owner's review of payments learners made to THIS academy with its
 * own manual methods (Academy Manual Payments).
 *
 * Who: the Organization Owner only (`assertCanViewAcademyFinance`), the same
 * rule as the academy's orders, revenue and payment-method settings. A
 * manager, instructor or another organization's owner is refused, and every
 * query is pinned to this academy and to `provider = 'academy_manual'`:
 * Atlas-collected payments stay with the Platform Owner's review.
 *
 * Lifecycle (server-side only — the client never sets a status):
 *
 *   awaiting proof  — payment `pending`,   review `not_required` (not listed)
 *   pending review  — payment `pending`,   review `pending`
 *   approved        — payment `succeeded`, review `approved`, order `paid`,
 *                     enrollment granted
 *   rejected        — payment `failed`,    review `rejected`, no access;
 *                     the order stays open so the learner can pay again
 *
 * Exactly once: each decision starts with `claimPendingReview`, one
 * conditional UPDATE (`… WHERE review_status = 'pending'`). Two owners (or a
 * double click, or approve racing reject) both reach it; PostgreSQL's row
 * lock lets one match and the other gets 0 rows and a 409, so the
 * enrollment, the review row, the audit entry and the email are written at
 * most once. The email is also deduplicated by the outbox on the payment id.
 *
 * Every effect of a decision — review row, payment and order state,
 * enrollment, audit entry, in-app notification and the outbox row of the
 * email — commits in ONE transaction, run as the reviewer in the
 * organization's tenant context (`runInTenantAndUserContext`), where the
 * `*_tenant_academy_manual_*` policies admit exactly these rows. The email is
 * handed to the queue after commit; a lost hand-off is found by the sweep.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AcademyContext } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { ACADEMY_MANUAL_PROVIDER_KEY } from '../../billing/dto/billing.constants';
import { PaymentReviewsRepository } from '../../billing/repositories/payment-reviews.repository';
import { PaymentProofsRepository } from '../../billing/repositories/payment-proofs.repository';
import { PaymentProofStorageService } from '../../billing/storage/payment-proof-storage.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { AcademyCoursePaymentsRepository } from '../repositories/academy-course-payments.repository';
import { CourseOrderPaymentApplicationService } from './course-order-payment-application.service';
import { assertCanViewAcademyFinance } from './academy-payouts.service';
import { ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS } from '../dto/course-commerce.constants';
import {
  toAcademyCoursePaymentDetailResponse,
  toAcademyCoursePaymentResponse,
  type AcademyCoursePaymentCountsResponse,
  type AcademyCoursePaymentDetailResponse,
  type AcademyCoursePaymentResponse,
} from '../dto/academy-course-payment.contract';
import type { AcademyCoursePaymentQueryDto } from '../dto/academy-course-payment-query.dto';
import type {
  ApproveAcademyCoursePaymentDto,
  RejectAcademyCoursePaymentDto,
} from '../dto/review-academy-course-payment.dto';

function courseTitleOf(snapshot: unknown): string {
  return (snapshot as { course?: { title?: string } } | null)?.course?.title ?? '';
}

function formatAmount(amountMinorUnits: bigint): string {
  return (Number(amountMinorUnits) / 100).toFixed(2);
}

/** A trimmed text, or `null` when blank. */
function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class AcademyCoursePaymentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyCoursePaymentsRepository: AcademyCoursePaymentsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentReviewsRepository: PaymentReviewsRepository,
    private readonly paymentProofsRepository: PaymentProofsRepository,
    private readonly paymentProofStorageService: PaymentProofStorageService,
    private readonly courseOrdersRepository: CourseOrdersRepository,
    private readonly courseOrderPaymentApplicationService: CourseOrderPaymentApplicationService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communicationService: CommunicationService,
    private readonly metrics: LearningMetricsService,
  ) {}

  async list(
    context: AcademyContext,
    academyId: string,
    query: AcademyCoursePaymentQueryDto,
  ): Promise<
    PaginatedResult<AcademyCoursePaymentResponse> & {
      counts: AcademyCoursePaymentCountsResponse;
    }
  > {
    const organizationId = assertCanViewAcademyFinance(context);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const { items, totalItems, counts } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        const result = await this.academyCoursePaymentsRepository.findManyForAcademy(
          tx,
          academyId,
          {
            reviewStatus: query.reviewStatus,
            methodType: query.methodType,
            from: query.from,
            to: query.to,
            search: query.search,
            sortBy: query.sortBy,
            sortDirection: query.sortDirection,
            skip: (page - 1) * pageSize,
            take: pageSize,
          },
        );
        const totals = await this.academyCoursePaymentsRepository.countByReviewStatus(
          tx,
          academyId,
        );
        return { ...result, counts: totals };
      });
    return {
      items: items.map(toAcademyCoursePaymentResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
      counts,
    };
  }

  async get(
    context: AcademyContext,
    academyId: string,
    paymentId: string,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    const row = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.academyCoursePaymentsRepository.findOneForAcademy(tx, academyId, paymentId),
    );
    if (!row || row.reviewStatus === 'not_required') {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return toAcademyCoursePaymentDetailResponse(row);
  }

  async approve(
    context: AcademyContext,
    reviewerId: string,
    academyId: string,
    paymentId: string,
    payload: ApproveAcademyCoursePaymentDto,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    const notes = optionalText(payload.notes);

    let emitted: EmitResult = { created: false, outboxId: null };
    const result = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      reviewerId,
      async (tx) => {
        const payment = await this.loadReviewable(tx, academyId, paymentId);
        const order = await this.courseOrdersRepository.findById(
          tx,
          payment.courseOrderId!,
        );
        if (!order || order.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        if (
          order.status === 'paid' ||
          order.status === 'refunded' ||
          order.status === 'cancelled'
        ) {
          throw new ConflictException({ messageKey: 'errors.courseOrder.notPayable' });
        }

        // The claim: only one decision ever wins.
        const claimed = await this.paymentsRepository.claimPendingReview(
          tx,
          paymentId,
          'approved',
          notes ?? undefined,
        );
        if (!claimed) {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'approved',
          reviewer: { connect: { id: reviewerId } },
          notes,
        });

        const latestProof = await this.paymentProofsRepository.findLatestForPayment(
          tx,
          paymentId,
        );
        const claimedPayment = await this.paymentsRepository.findByIdAnyOrganization(
          tx,
          paymentId,
        );
        // Marks the payment succeeded and the order paid, and grants (or
        // re-grants) the enrollment through the existing enrollment path.
        // No ledger entry: `payment_collection_mode_snapshot` is
        // `academy_manual`, and only `atlas_payments` writes one.
        await this.courseOrderPaymentApplicationService.applySuccessfulPayment(
          tx,
          claimedPayment!,
          order,
        );

        await this.auditLogWriterService.write(tx, {
          actorUserId: reviewerId,
          organizationId,
          academyId,
          role: context.academyRole,
          action: 'academy.course_payment.approved',
          targetType: 'payment',
          targetId: paymentId,
          context: { courseOrderId: order.id },
        });

        emitted = await this.communicationService.emit(tx, {
          key: 'course.payment.approved',
          recipientUserId: order.studentId,
          organizationId,
          academyId,
          entity: { type: 'payment', id: paymentId },
          values: {
            courseTitle: courseTitleOf(order.snapshot),
            amount: formatAmount(payment.amountMinorUnits),
            currency: payment.currency,
            methodType: payment.methodType,
          },
        });

        const row = await this.academyCoursePaymentsRepository.findOneForAcademy(
          tx,
          academyId,
          paymentId,
        );
        return {
          response: toAcademyCoursePaymentDetailResponse(row!),
          proofUploadedAt: latestProof?.uploadedAt ?? null,
        };
      },
    );

    if (result.proofUploadedAt) {
      this.metrics.recordCheckoutApprovalLatency(
        (Date.now() - result.proofUploadedAt.getTime()) / 1000,
      );
    }
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    return result.response;
  }

  async reject(
    context: AcademyContext,
    reviewerId: string,
    academyId: string,
    paymentId: string,
    payload: RejectAcademyCoursePaymentDto,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    const reason = optionalText(payload.reason);

    let emitted: EmitResult = { created: false, outboxId: null };
    const response = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      reviewerId,
      async (tx) => {
        const payment = await this.loadReviewable(tx, academyId, paymentId);
        const order = await this.courseOrdersRepository.findById(
          tx,
          payment.courseOrderId!,
        );
        if (!order || order.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }

        const claimed = await this.paymentsRepository.claimPendingReview(
          tx,
          paymentId,
          'rejected',
          reason ?? undefined,
        );
        if (!claimed) {
          throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
        }

        await this.paymentReviewsRepository.create(tx, {
          payment: { connect: { id: paymentId } },
          status: 'rejected',
          reviewer: { connect: { id: reviewerId } },
          notes: reason,
        });
        await this.courseOrderPaymentApplicationService.applyFailedPayment(
          tx,
          payment,
          'errors.payment.rejectedByReviewer',
        );

        // The order stays open: the learner may pay again (a new payment on
        // the same order) for the next `ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS`.
        if (order.status === 'draft' || order.status === 'pending_payment') {
          const reopenUntil = new Date(
            Date.now() + ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS * 3_600_000,
          );
          if (order.expiresAt < reopenUntil) {
            await this.courseOrdersRepository.update(tx, order.id, {
              expiresAt: reopenUntil,
            });
          }
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: reviewerId,
          organizationId,
          academyId,
          role: context.academyRole,
          action: 'academy.course_payment.rejected',
          targetType: 'payment',
          targetId: paymentId,
          context: { courseOrderId: order.id, ...(reason ? { notes: reason } : {}) },
        });

        emitted = await this.communicationService.emit(tx, {
          key: 'course.payment.rejected',
          recipientUserId: order.studentId,
          organizationId,
          academyId,
          entity: { type: 'payment', id: paymentId },
          values: {
            courseTitle: courseTitleOf(order.snapshot),
            amount: formatAmount(payment.amountMinorUnits),
            currency: payment.currency,
            methodType: payment.methodType,
            ...(reason ? { reason } : {}),
          },
        });

        const row = await this.academyCoursePaymentsRepository.findOneForAcademy(
          tx,
          academyId,
          paymentId,
        );
        return toAcademyCoursePaymentDetailResponse(row!);
      },
    );

    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    return response;
  }

  /** Streams the latest proof — after the same owner and academy checks as the detail. */
  async getProofFile(
    context: AcademyContext,
    academyId: string,
    paymentId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const organizationId = assertCanViewAcademyFinance(context);
    const proof = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const row = await this.academyCoursePaymentsRepository.findOneForAcademy(
          tx,
          academyId,
          paymentId,
        );
        if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return this.paymentProofsRepository.findLatestForPayment(tx, paymentId);
      },
    );
    if (!proof) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const buffer = await this.paymentProofStorageService.getObject(proof.storageKey);
    return { buffer, mimeType: proof.mimeType, fileName: proof.fileName };
  }

  /** This academy's `academy_manual` course payment, or 404; 409 unless it is waiting for review. */
  private async loadReviewable(
    tx: Prisma.TransactionClient,
    academyId: string,
    paymentId: string,
  ) {
    const payment = await this.paymentsRepository.findByIdAnyOrganization(tx, paymentId);
    if (
      !payment ||
      payment.payeeAcademyId !== academyId ||
      payment.provider !== ACADEMY_MANUAL_PROVIDER_KEY ||
      !payment.courseOrderId
    ) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    if (payment.reviewStatus !== 'pending') {
      throw new ConflictException({ messageKey: 'errors.payment.notPendingReview' });
    }
    return payment;
  }
}
