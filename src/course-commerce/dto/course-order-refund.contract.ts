/**
 * `CourseOrderRefund` response contract (Phase P13) — the LEARNER's view of
 * the refund on their own order (`course-orders/:id/refund`).
 *
 * It carries no user id. `requested_by` is the learner for a self-service
 * refund but the Organization Owner for a refund the academy recorded
 * (Academy Manual Payments), and a staff member's user id is not the
 * learner's to see; the learner's screen needs only the amount, status
 * and dates. Who recorded a refund is shown to the academy on its own
 * payment detail, never here.
 */
import type { CourseOrderRefund as PrismaCourseOrderRefund } from '@prisma/client';

export interface CourseOrderRefundResponse {
  readonly id: string;
  readonly courseOrderId: string;
  readonly paymentId: string;
  readonly refundType: PrismaCourseOrderRefund['refundType'];
  readonly status: PrismaCourseOrderRefund['status'];
  readonly money: { readonly amountMinorUnits: number; readonly currency: string };
  readonly reason?: string;
  readonly requestedAt: string;
  readonly processedAt?: string;
}

export function toCourseOrderRefundResponse(
  refund: PrismaCourseOrderRefund,
): CourseOrderRefundResponse {
  return {
    id: refund.id,
    courseOrderId: refund.courseOrderId,
    paymentId: refund.paymentId,
    refundType: refund.refundType,
    status: refund.status,
    money: {
      amountMinorUnits: Number(refund.amountMinorUnits),
      currency: refund.currency,
    },
    reason: refund.reason ?? undefined,
    requestedAt: refund.requestedAt.toISOString(),
    processedAt: refund.processedAt?.toISOString(),
  };
}
