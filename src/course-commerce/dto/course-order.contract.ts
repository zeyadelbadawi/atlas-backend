/** `CourseOrder` response contract (Phase P13, master plan §5.8/§23). No frontend contract exists to mirror (see `create-course-order.dto.ts`'s own doc comment) — this shape is designed directly from §23's lifecycle. */
import type { CourseOrder as PrismaCourseOrder } from '@prisma/client';
import type { MoneyResponse } from '../../billing/dto/checkout.contract';

export interface CourseOrderSnapshotResponse {
  readonly course: { readonly id: string; readonly title: string };
  readonly price: MoneyResponse;
  readonly capturedAt: string;
}

export interface CourseOrderResponse {
  readonly id: string;
  readonly studentId: string;
  readonly courseId: string;
  readonly academyId: string;
  readonly organizationId: string;
  readonly snapshot: CourseOrderSnapshotResponse;
  readonly status: PrismaCourseOrder['status'];
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly paidAt?: string;
  readonly createdAt: string;
}

export function toCourseOrderResponse(order: PrismaCourseOrder): CourseOrderResponse {
  return {
    id: order.id,
    studentId: order.studentId,
    courseId: order.courseId,
    academyId: order.academyId,
    organizationId: order.organizationId,
    snapshot: order.snapshot as unknown as CourseOrderSnapshotResponse,
    status: order.status,
    expiresAt: order.expiresAt.toISOString(),
    idempotencyKey: order.idempotencyKey,
    paidAt: order.paidAt?.toISOString(),
    createdAt: order.createdAt.toISOString(),
  };
}
