/**
 * Platform Owner course-payment review contracts
 * (`GET /platform-course-order-payments[/:id]`).
 *
 * Both add the review context the reviewer needs instead of raw ids: the
 * academy's name, the course title (as frozen on the order), the order's
 * own status and, if one was ever requested, its refund status.
 *
 * The LIST item additionally drops the proof's free-text `note` (the
 * proof's presence, file name and upload time stay) and the instructions
 * snapshot, like the subscription list; the detail keeps the snapshot.
 * The commission snapshot stays: this surface is Platform-Owner-only and
 * the commission is the Platform's own figure.
 */
import type { CourseOrderRefund, CourseOrder } from '@prisma/client';
import type { PaymentWithCourseReviewContext } from '../../billing/repositories/payments.repository';
import {
  toCourseOrderPaymentResponse,
  type CourseOrderPaymentResponse,
} from './course-order-payment.contract';

export interface PlatformCourseOrderPaymentReviewContext {
  readonly academy?: { readonly id: string; readonly name: string };
  readonly course?: { readonly id: string; readonly title: string };
  readonly courseOrderStatus?: CourseOrder['status'];
  readonly refundStatus?: CourseOrderRefund['status'];
}

export type PlatformCourseOrderPaymentResponse = CourseOrderPaymentResponse &
  PlatformCourseOrderPaymentReviewContext;

function toReviewContext(
  payment: PaymentWithCourseReviewContext,
): PlatformCourseOrderPaymentReviewContext {
  const order = payment.courseOrder;
  const snapshotTitle = (order?.snapshot as { course?: { title?: unknown } } | null)
    ?.course?.title;
  return {
    academy: payment.payeeAcademy
      ? { id: payment.payeeAcademy.id, name: payment.payeeAcademy.name }
      : undefined,
    course: order
      ? {
          id: order.courseId,
          title:
            typeof snapshotTitle === 'string'
              ? snapshotTitle
              : (order.course?.title ?? ''),
        }
      : undefined,
    courseOrderStatus: order?.status,
    refundStatus: order?.refund?.status,
  };
}

export function toPlatformCourseOrderPaymentListItemResponse(
  payment: PaymentWithCourseReviewContext,
): PlatformCourseOrderPaymentResponse {
  const response = toCourseOrderPaymentResponse(payment);
  return {
    ...response,
    proof: response.proof ? { ...response.proof, note: undefined } : undefined,
    instructions: undefined,
    ...toReviewContext(payment),
  };
}

export function toPlatformCourseOrderPaymentDetailResponse(
  payment: PaymentWithCourseReviewContext,
): PlatformCourseOrderPaymentResponse {
  return { ...toCourseOrderPaymentResponse(payment), ...toReviewContext(payment) };
}
