/**
 * CourseOrderPaymentApplicationService — the ONE place a course-order
 * Payment's success or failure is actually applied to
 * `payments`/`course_orders`/`enrollments`/`revenue_ledger_entries` —
 * the Course Commerce analog of `PaymentApplicationService` (P12),
 * deliberately kept as its OWN class rather than a branch inside that one
 * (see `CourseCommerceModule`'s own doc comment for the full "why a
 * separate module, not a modification of `PaymentApplicationService`"
 * reasoning: avoiding a circular module dependency between `BillingModule`
 * and `LearningModule`/`CourseModule`, which this new money flow
 * genuinely needs both of). Both `PlatformCourseOrderPaymentsService`'s
 * manual-review approval (the only real, connected trigger in this phase —
 * `ManualTransferProvider` has no online success webhook) and a future
 * real-gateway webhook path call this SAME method — never two parallel
 * "apply success" implementations, matching master plan §10's transaction
 * rule and P12's own established precedent verbatim.
 *
 * Every method here takes an already-open `Prisma.TransactionClient` — it
 * never opens its own `runInTenantContext`/`runInUserContext`/
 * `runInTenantAndUserContext`; the caller (`PlatformCourseOrderPaymentsService`)
 * already opened `runInTenantAndUserContext(courseOrder.organizationId,
 * reviewerId, ...)` — the ACTOR's own id, matching
 * `PlatformPaymentService.approvePayment`'s identical P12 precedent,
 * never the buyer's, because `payment_reviews`'s own RLS policy requires
 * `reviewed_by = app.current_user_id`. The Enrollment/CourseOrder writes
 * this class performs are covered by dedicated, additive
 * `is_platform_owner()`-gated RLS policies
 * (`enrollments_platform_insert`/`_update`/`_select`,
 * `course_orders_platform_update` — see the P13 RLS-fix migrations'
 * own doc comments) rather than relying on the buyer's own
 * self-scoped policies, since the active context here is the reviewer,
 * not the buyer. Every write below still lands inside the SAME one
 * atomic transaction the caller opened — payment succeeds → enrollment
 * created → ledger entries written all succeed or all roll back
 * together, matching master plan §10's explicit transaction rule and §23's
 * "the one failure mode that must be structurally impossible" instruction.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CourseOrder, Payment } from '@prisma/client';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { EnrollmentsRepository } from '../../learning/repositories/enrollments.repository';
import { EnrollmentsService } from '../../learning/services/enrollments.service';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { applyBasisPoints } from '../../billing/utils/commission-math.util';
import { CourseOrdersRepository } from '../repositories/course-orders.repository';
import { RevenueLedgerEntriesRepository } from '../repositories/revenue-ledger-entries.repository';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';

@Injectable()
export class CourseOrderPaymentApplicationService {
  constructor(
    private readonly paymentsRepository: PaymentsRepository,
    private readonly courseOrdersRepository: CourseOrdersRepository,
    private readonly revenueLedgerEntriesRepository: RevenueLedgerEntriesRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly coursesRepository: CoursesRepository,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
  ) {}

  /**
   * Applies a successful course-order Payment: marks it `succeeded`,
   * completes the CourseOrder, creates (or re-unlocks, after a prior
   * refund) the student's Enrollment, and — for Atlas Payments mode only
   * — inserts the `sale`/`platform_fee` ledger entries computed from the
   * commission snapshot already frozen on the Payment row at creation
   * time (§4.2 — never recomputed here).
   *
   * Phase 2 note — deliberately never calls
   * `EntitlementEnforcementService` here: blocking an ALREADY-successful
   * payment because of a plan limit is a billing-policy decision (would
   * require a checkout-time pre-authorization check instead, itself
   * commerce-phase territory) outside Phase 2's "server-side authorization
   * and subscription lifecycle" charter — audited and intentionally left
   * as-is (see the Phase 2 completion report's own audit section). It
   * DOES enqueue a real usage-recompute trigger below, same as the free
   * enrollment path — a paid enrollment is still a real `students` usage
   * change the Usage page must reflect.
   */
  async applySuccessfulPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    courseOrder: CourseOrder,
  ): Promise<Payment> {
    const updated = await this.paymentsRepository.update(tx, payment.id, {
      status: 'succeeded',
      failureReason: null,
      nextAction: Prisma.JsonNull,
    });

    await this.courseOrdersRepository.update(tx, courseOrder.id, {
      status: 'paid',
      paidAt: new Date(),
    });

    const course = await this.coursesRepository.findById(tx, courseOrder.courseId);
    if (course) {
      const existingEnrollment = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        courseOrder.studentId,
        course.id,
      );
      if (existingEnrollment) {
        // A prior enrollment exists in a non-access-granting state (e.g.
        // `unavailable` after an earlier refund on a since-repurchased
        // course) — re-grant access by transitioning it, never a second
        // Enrollment row (the `(studentId, courseId)` unique constraint
        // would reject one anyway; this is the honest, intentional path,
        // not a rescue from a constraint violation).
        if (existingEnrollment.status !== 'enrolled') {
          await this.enrollmentsRepository.update(tx, existingEnrollment.id, {
            status: 'enrolled',
            enrolledAt: new Date(),
          });
        }
      } else {
        await this.enrollmentsService.createEnrollmentInTransaction(
          tx,
          courseOrder.studentId,
          course,
        );
      }
    }

    if (payment.paymentCollectionModeSnapshot === 'atlas_payments') {
      await this.insertSaleLedgerEntries(tx, payment, courseOrder);
    }
    // Organization-Owned Gateway mode: no ledger entry at all — Atlas was
    // never a party to this money flow (this session's explicit
    // requirement, restated here at the one call site that could
    // otherwise accidentally create a commission liability).

    // Phase 2 — real reactive usage-recompute trigger (a paid enrollment
    // is a real `students` usage change too). See this method's own doc
    // comment for why this is the SAFE half (accuracy) of Phase 2's
    // change to this method, never the entitlement-enforcement half.
    await this.tenantUsageRecomputeProducer.enqueueOne(courseOrder.organizationId);

    return updated;
  }

  async applyFailedPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    failureReasonKey: string,
  ): Promise<Payment> {
    return this.paymentsRepository.update(tx, payment.id, {
      status: 'failed',
      failureReason: failureReasonKey,
      nextAction: Prisma.JsonNull,
    });
  }

  private async insertSaleLedgerEntries(
    tx: Prisma.TransactionClient,
    payment: Payment,
    courseOrder: CourseOrder,
  ): Promise<void> {
    const now = new Date();
    await this.revenueLedgerEntriesRepository.create(tx, {
      academy: { connect: { id: courseOrder.academyId } },
      courseOrder: { connect: { id: courseOrder.id } },
      payment: { connect: { id: payment.id } },
      entryType: 'sale',
      amountMinorUnits: payment.amountMinorUnits,
      currency: payment.currency,
      occurredAt: now,
    });

    const commissionAmount = payment.commissionAmountMinorUnits;
    if (commissionAmount != null && commissionAmount > 0n) {
      await this.revenueLedgerEntriesRepository.create(tx, {
        academy: { connect: { id: courseOrder.academyId } },
        courseOrder: { connect: { id: courseOrder.id } },
        payment: { connect: { id: payment.id } },
        entryType: 'platform_fee',
        amountMinorUnits: -commissionAmount,
        currency: payment.currency,
        occurredAt: now,
      });
    }
  }

  /** Re-exported for callers that need to compute a commission amount from a rate outside the Payment-creation path (none in this phase — kept for symmetry/testability, mirrors `commission-math.util.ts`'s own precedent of being the single place this arithmetic happens). */
  static computeCommissionAmount(amountMinorUnits: bigint, basisPoints: number): bigint {
    return applyBasisPoints(amountMinorUnits, basisPoints);
  }
}
