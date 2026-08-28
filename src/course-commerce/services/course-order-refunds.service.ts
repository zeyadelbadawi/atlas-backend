/**
 * CourseOrderRefundsService — `POST course-orders/:id/refund`, buyer-scoped
 * and buyer-initiated (this session's product direction: a customer-
 * friendly, self-service full refund within `REFUND_WINDOW_DAYS` of
 * purchase — no Platform Owner review gate). The refund lifecycle itself
 * is represented explicitly by `CourseOrderRefund` (schema.prisma's own
 * P13 doc comment) — this service is the only writer of that table.
 *
 * Idempotency: `course_order_refunds.course_order_id` is `@unique` at the
 * database level — a real constraint, not merely an application check —
 * so a second refund attempt (retried request, double-click, concurrent
 * tab) can never produce a second financial mutation. This method checks
 * first (fast path) and also catches the constraint violation (race-safe
 * fallback), exactly mirroring `CheckoutService.createCheckout`'s and
 * `CourseOrdersService.createOrder`'s identical idempotency pattern — and
 * either way, an already-refunded order resolves to returning the
 * existing refund record, never an error, for a genuinely idempotent
 * retry.
 *
 * Runs the whole eligibility-check + write sequence under
 * `runInTenantAndUserContext(order.organizationId, order.studentId, ...)`
 * — the SAME dual-context shape `CourseOrderPaymentApplicationService`
 * uses for the mirror-image "apply success" transaction, needed here for
 * the identical reason: the Enrollment reversal is user-scoped, the
 * ledger-reversal entries are organization-scoped, and both must land in
 * ONE atomic transaction with the refund record itself.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../../learning/repositories/enrollments.repository';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { CourseOrderRefundsRepository } from '../repositories/course-order-refunds.repository';
import { RevenueLedgerEntriesRepository } from '../repositories/revenue-ledger-entries.repository';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';
import { REFUND_WINDOW_DAYS } from '../dto/course-commerce.constants';
import {
  toCourseOrderRefundResponse,
  type CourseOrderRefundResponse,
} from '../dto/course-order-refund.contract';
import type { RequestCourseOrderRefundDto } from '../dto/request-course-order-refund.dto';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CourseOrderRefundsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly courseOrdersRepository: CourseOrdersRepository,
    private readonly courseOrderRefundsRepository: CourseOrderRefundsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly revenueLedgerEntriesRepository: RevenueLedgerEntriesRepository,
    private readonly notificationFanoutService: NotificationFanoutService,
  ) {}

  async requestRefund(
    studentId: string,
    orderId: string,
    payload: RequestCourseOrderRefundDto,
  ): Promise<CourseOrderRefundResponse> {
    // Step 1 — resolve the order under the buyer's own user context (the
    // only context that can see it at all) to determine which
    // Organization/Academy the atomic step 2 transaction needs.
    const order = await this.tenancyContextService.runInUserContext(studentId, (tx) =>
      this.courseOrdersRepository.findByIdForStudent(tx, studentId, orderId),
    );
    if (!order) throw new NotFoundException({ messageKey: 'errors.notFound' });

    let notifiedNew = false;
    const courseTitle =
      (order.snapshot as { course?: { title?: string } } | null)?.course?.title ??
      'your course';

    const result = await this.tenancyContextService.runInTenantAndUserContext(
      order.organizationId,
      studentId,
      async (tx) => {
        const existingRefund =
          await this.courseOrderRefundsRepository.findByCourseOrderId(tx, order.id);
        if (existingRefund) return toCourseOrderRefundResponse(existingRefund);

        const fresh = await this.courseOrdersRepository.findByIdForStudent(
          tx,
          studentId,
          orderId,
        );
        if (!fresh) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (fresh.status !== 'paid') {
          throw new ConflictException({
            messageKey: 'errors.courseOrder.refundNotEligible',
          });
        }
        if (!fresh.paidAt) {
          // Structurally unreachable (status='paid' always sets paidAt in
          // the same transaction, `CourseOrderPaymentApplicationService`)
          // — a real, honest failure if it ever happens anyway, never a
          // silent assumption.
          throw new ConflictException({
            messageKey: 'errors.courseOrder.refundNotEligible',
          });
        }
        const deadline = new Date(
          fresh.paidAt.getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );
        if (Date.now() > deadline.getTime()) {
          throw new ForbiddenException({
            messageKey: 'errors.courseOrder.refundWindowElapsed',
          });
        }

        const succeededPayment =
          await this.paymentsRepository.findSucceededForCourseOrder(tx, fresh.id);
        if (!succeededPayment) {
          // Structurally unreachable alongside `status === 'paid'` — a
          // real, honest failure if it ever happens anyway.
          throw new ConflictException({
            messageKey: 'errors.courseOrder.refundNotEligible',
          });
        }

        const snapshot = fresh.snapshot as {
          price: { amountMinorUnits: number; currency: string };
        };
        const amountMinorUnits = BigInt(snapshot.price.amountMinorUnits);
        const now = new Date();

        let refund;
        try {
          refund = await this.courseOrderRefundsRepository.create(tx, {
            courseOrder: { connect: { id: fresh.id } },
            payment: { connect: { id: succeededPayment.id } },
            refundType: 'full',
            status: 'succeeded',
            amountMinorUnits,
            currency: snapshot.price.currency,
            reason: payload.reason,
            requester: { connect: { id: studentId } },
            idempotencyKey: payload.idempotencyKey,
            processedAt: now,
          });
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            const raced = await this.courseOrderRefundsRepository.findByCourseOrderId(
              tx,
              fresh.id,
            );
            if (raced) return toCourseOrderRefundResponse(raced);
          }
          throw error;
        }

        await this.courseOrdersRepository.update(tx, fresh.id, { status: 'refunded' });

        // Enrollment reversal (§23's recommended default, this phase's
        // product direction): a full refund revokes course access rather
        // than deleting the Enrollment row — progress/history stays
        // intact for a possible future dispute reversal.
        const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
          tx,
          studentId,
          fresh.courseId,
        );
        if (enrollment) {
          await this.enrollmentsRepository.update(tx, enrollment.id, {
            status: 'unavailable',
          });
        }

        // Ledger reversal — ONLY for Atlas Payments mode (a
        // Organization-Owned Gateway sale never wrote a ledger entry in
        // the first place, so there is nothing to reverse; Atlas remains
        // structurally never a party to that money flow).
        if (succeededPayment.paymentCollectionModeSnapshot === 'atlas_payments') {
          await this.revenueLedgerEntriesRepository.create(tx, {
            academy: { connect: { id: fresh.academyId } },
            courseOrder: { connect: { id: fresh.id } },
            payment: { connect: { id: succeededPayment.id } },
            entryType: 'refund',
            amountMinorUnits: -amountMinorUnits,
            currency: snapshot.price.currency,
            occurredAt: now,
          });

          const commissionAmount = succeededPayment.commissionAmountMinorUnits;
          if (commissionAmount != null && commissionAmount > 0n) {
            // Full refund only in this phase → the reversal is always the
            // FULL, exact frozen commission amount (§4.2's proportional
            // rule, degenerate at proportion = 1 for a full refund) — the
            // snapshot is reused directly, never recomputed from a
            // possibly-since-changed live commission configuration.
            await this.revenueLedgerEntriesRepository.create(tx, {
              academy: { connect: { id: fresh.academyId } },
              courseOrder: { connect: { id: fresh.id } },
              payment: { connect: { id: succeededPayment.id } },
              entryType: 'commission_reversal',
              amountMinorUnits: commissionAmount,
              currency: snapshot.price.currency,
              occurredAt: now,
            });
          }
        }

        // Phase P17 — notify the buyer, same transaction as the refund itself.
        notifiedNew = await this.notificationFanoutService.notify(tx, {
          userId: studentId,
          type: 'billing',
          priority: 'medium',
          titleKey: 'notifications:events.courseOrderRefunded.title',
          messageKey: 'notifications:events.courseOrderRefunded.message',
          values: { courseTitle },
          dedupeKey: `course_order_refunded:${fresh.id}`,
        });

        return toCourseOrderRefundResponse(refund);
      },
    );

    await this.notificationFanoutService.sendEmailAfterCommit(studentId, notifiedNew, {
      template: 'course_order_refunded',
      values: { courseTitle },
    });

    return result;
  }

  async getRefund(
    studentId: string,
    orderId: string,
  ): Promise<CourseOrderRefundResponse | null> {
    const refund = await this.tenancyContextService.runInUserContext(
      studentId,
      async (tx) => {
        const order = await this.courseOrdersRepository.findByIdForStudent(
          tx,
          studentId,
          orderId,
        );
        if (!order) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return this.courseOrderRefundsRepository.findByCourseOrderId(tx, order.id);
      },
    );
    return refund ? toCourseOrderRefundResponse(refund) : null;
  }
}
