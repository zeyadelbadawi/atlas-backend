/** `CourseOrderRefund` response contract (Phase P13). */
import type { CourseOrderRefund as PrismaCourseOrderRefund } from '@prisma/client';

export interface CourseOrderRefundResponse {
  readonly id: string;
  readonly courseOrderId: string;
  readonly paymentId: string;
  readonly refundType: PrismaCourseOrderRefund['refundType'];
  readonly status: PrismaCourseOrderRefund['status'];
  readonly money: { readonly amountMinorUnits: number; readonly currency: string };
  readonly reason?: string;
  readonly requestedBy: string;
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
    requestedBy: refund.requestedBy,
    requestedAt: refund.requestedAt.toISOString(),
    processedAt: refund.processedAt?.toISOString(),
  };
}
