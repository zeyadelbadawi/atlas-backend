/**
 * Academy Manual Payments — the Client Owner's view of a learner's payment
 * to the academy (review list and detail).
 *
 * The learner appears as a name and a masked email, as on the academy
 * Orders page. The proof is never a storage URL: `fileUrl` is the
 * authenticated API route that streams it after re-checking access.
 */
import type { Prisma } from '@prisma/client';
import { maskEmail } from '../../identity/services/email-otp.service';
import type { ManualPaymentInstructionsResponse } from '../../billing/dto/payment-method.contract';

export const ACADEMY_COURSE_PAYMENT_SELECT = {
  id: true,
  courseOrderId: true,
  payeeAcademyId: true,
  methodType: true,
  methodKey: true,
  amountMinorUnits: true,
  currency: true,
  status: true,
  reviewStatus: true,
  reviewNotes: true,
  instructionsSnapshot: true,
  createdAt: true,
  updatedAt: true,
  payer: { select: { name: true, email: true } },
  courseOrder: {
    select: {
      id: true,
      status: true,
      courseId: true,
      snapshot: true,
      course: { select: { title: true } },
    },
  },
  proofs: {
    orderBy: { uploadedAt: 'desc' as const },
    take: 1,
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      note: true,
      payerReference: true,
      uploadedAt: true,
    },
  },
} satisfies Prisma.PaymentSelect;

export const ACADEMY_COURSE_PAYMENT_DETAIL_SELECT = {
  ...ACADEMY_COURSE_PAYMENT_SELECT,
  reviews: {
    orderBy: { reviewedAt: 'desc' as const },
    select: {
      id: true,
      status: true,
      notes: true,
      reviewedAt: true,
      reviewer: { select: { name: true } },
    },
  },
} satisfies Prisma.PaymentSelect;

export type AcademyCoursePaymentRow = Prisma.PaymentGetPayload<{
  select: typeof ACADEMY_COURSE_PAYMENT_SELECT;
}>;
export type AcademyCoursePaymentDetailRow = Prisma.PaymentGetPayload<{
  select: typeof ACADEMY_COURSE_PAYMENT_DETAIL_SELECT;
}>;

export interface AcademyCoursePaymentProofResponse {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly note?: string;
  readonly payerReference?: string;
  readonly uploadedAt: string;
  /** Authenticated API route (`GET …/proof/file`), never a storage URL. */
  readonly fileUrl: string;
}

export interface AcademyCoursePaymentResponse {
  readonly id: string;
  readonly academyId: string;
  readonly courseOrderId: string;
  readonly course: { readonly id: string; readonly title: string };
  readonly learner: { readonly name: string; readonly maskedEmail: string };
  readonly methodType: AcademyCoursePaymentRow['methodType'];
  readonly money: { readonly amountMinorUnits: number; readonly currency: string };
  readonly status: AcademyCoursePaymentRow['status'];
  readonly reviewStatus: AcademyCoursePaymentRow['reviewStatus'];
  readonly reviewNotes?: string;
  readonly orderStatus: string;
  readonly proof?: AcademyCoursePaymentProofResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AcademyCoursePaymentReviewResponse {
  readonly id: string;
  readonly status: string;
  readonly notes?: string;
  readonly reviewedAt: string;
  readonly reviewerName?: string;
}

export interface AcademyCoursePaymentDetailResponse extends AcademyCoursePaymentResponse {
  /** The details the learner was shown when they chose the method. */
  readonly instructions?: ManualPaymentInstructionsResponse;
  readonly reviews: readonly AcademyCoursePaymentReviewResponse[];
}

/** Per-tab totals for the review list (the same academy, before filters). */
export interface AcademyCoursePaymentCountsResponse {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
}

function courseTitle(row: AcademyCoursePaymentRow): string {
  const fromSnapshot = (
    row.courseOrder?.snapshot as { course?: { title?: string } } | null
  )?.course?.title;
  return fromSnapshot ?? row.courseOrder?.course?.title ?? '';
}

export function toAcademyCoursePaymentResponse(
  row: AcademyCoursePaymentRow,
): AcademyCoursePaymentResponse {
  const proof = row.proofs[0];
  const academyId = row.payeeAcademyId ?? '';
  return {
    id: row.id,
    academyId,
    courseOrderId: row.courseOrderId ?? '',
    course: { id: row.courseOrder?.courseId ?? '', title: courseTitle(row) },
    learner: {
      name: row.payer?.name ?? '',
      maskedEmail: row.payer ? maskEmail(row.payer.email) : '',
    },
    methodType: row.methodType,
    money: { amountMinorUnits: Number(row.amountMinorUnits), currency: row.currency },
    status: row.status,
    reviewStatus: row.reviewStatus,
    reviewNotes: row.reviewNotes ?? undefined,
    orderStatus: row.courseOrder?.status ?? '',
    proof: proof
      ? {
          id: proof.id,
          fileName: proof.fileName,
          mimeType: proof.mimeType,
          note: proof.note ?? undefined,
          payerReference: proof.payerReference ?? undefined,
          uploadedAt: proof.uploadedAt.toISOString(),
          fileUrl: `/academies/${academyId}/course-payments/${row.id}/proof/file`,
        }
      : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAcademyCoursePaymentDetailResponse(
  row: AcademyCoursePaymentDetailRow,
): AcademyCoursePaymentDetailResponse {
  return {
    ...toAcademyCoursePaymentResponse(row),
    instructions:
      (row.instructionsSnapshot as unknown as ManualPaymentInstructionsResponse | null) ??
      undefined,
    reviews: row.reviews.map((review) => ({
      id: review.id,
      status: review.status,
      notes: review.notes ?? undefined,
      reviewedAt: review.reviewedAt.toISOString(),
      reviewerName: review.reviewer?.name ?? undefined,
    })),
  };
}
