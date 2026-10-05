/**
 * Academy Manual Payments — a learner's own payment history ("My payments",
 * `GET course-payments`). Every course payment the learner made, newest
 * first, with what the learner needs to act on it: the review state, the
 * rejection reason, the proof they sent, and whether they can pay again.
 */
import type { Prisma } from '@prisma/client';

export const LEARNER_COURSE_PAYMENT_SELECT = {
  id: true,
  courseOrderId: true,
  payeeAcademyId: true,
  methodType: true,
  provider: true,
  amountMinorUnits: true,
  currency: true,
  status: true,
  reviewStatus: true,
  reviewNotes: true,
  createdAt: true,
  updatedAt: true,
  courseOrder: {
    select: {
      id: true,
      status: true,
      courseId: true,
      snapshot: true,
      payments: {
        select: { id: true },
        orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
        take: 1,
      },
    },
  },
  proofs: {
    orderBy: { uploadedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      payerReference: true,
      uploadedAt: true,
    },
  },
} satisfies Prisma.PaymentSelect;

export type LearnerCoursePaymentRow = Prisma.PaymentGetPayload<{
  select: typeof LEARNER_COURSE_PAYMENT_SELECT;
}>;

export interface LearnerCoursePaymentResponse {
  readonly id: string;
  readonly courseOrderId: string;
  readonly academyId: string;
  readonly course: { readonly id: string; readonly title: string };
  readonly methodType: LearnerCoursePaymentRow['methodType'];
  /** `academy_manual` — paid to the academy; otherwise collected by Atlas. */
  readonly provider: string;
  readonly money: { readonly amountMinorUnits: number; readonly currency: string };
  readonly status: LearnerCoursePaymentRow['status'];
  readonly reviewStatus: LearnerCoursePaymentRow['reviewStatus'];
  /** The reviewer's reason — only on a rejected payment. */
  readonly rejectionReason?: string;
  readonly orderStatus: string;
  readonly proof?: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly payerReference?: string;
    readonly uploadedAt: string;
    /** Authenticated API route — the learner's own proof only. */
    readonly fileUrl: string;
  };
  /** The payment is waiting for the learner's proof. */
  readonly awaitingProof: boolean;
  /** Rejected, the newest payment of an order that is still open: the learner may pay again. */
  readonly canSubmitNewPayment: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const OPEN_ORDER_STATUSES = new Set(['draft', 'pending_payment']);

export function toLearnerCoursePaymentResponse(
  row: LearnerCoursePaymentRow,
): LearnerCoursePaymentResponse {
  const order = row.courseOrder;
  const proof = row.proofs[0];
  const title =
    (order?.snapshot as { course?: { title?: string } } | null)?.course?.title ?? '';
  const isNewest = order?.payments[0]?.id === row.id;
  const orderStatus = order?.status ?? '';
  return {
    id: row.id,
    courseOrderId: row.courseOrderId ?? '',
    academyId: row.payeeAcademyId ?? '',
    course: { id: order?.courseId ?? '', title },
    methodType: row.methodType,
    provider: row.provider,
    money: { amountMinorUnits: Number(row.amountMinorUnits), currency: row.currency },
    status: row.status,
    reviewStatus: row.reviewStatus,
    rejectionReason:
      row.reviewStatus === 'rejected' ? (row.reviewNotes ?? undefined) : undefined,
    orderStatus,
    proof: proof
      ? {
          fileName: proof.fileName,
          mimeType: proof.mimeType,
          payerReference: proof.payerReference ?? undefined,
          uploadedAt: proof.uploadedAt.toISOString(),
          fileUrl: `/course-orders/${row.courseOrderId}/payments/${row.id}/proof/file`,
        }
      : undefined,
    awaitingProof:
      row.status === 'pending' &&
      row.reviewStatus === 'not_required' &&
      OPEN_ORDER_STATUSES.has(orderStatus),
    canSubmitNewPayment:
      row.reviewStatus === 'rejected' && isNewest && OPEN_ORDER_STATUSES.has(orderStatus),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
