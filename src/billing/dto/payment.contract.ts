/**
 * `Payment`/`PaymentAttempt`/`PaymentProof`/`PaymentReview` response
 * contracts — matches `payment.types.ts` field-for-field. One shape for
 * manual and gateway payments (frontend's own governing rule) — nothing
 * here branches on `methodType`.
 */
import type {
  Payment as PrismaPayment,
  PaymentAttempt as PrismaPaymentAttempt,
  PaymentProof as PrismaPaymentProof,
  PaymentReview as PrismaPaymentReview,
} from '@prisma/client';
import type { MoneyResponse } from './checkout.contract';

export interface PaymentAttemptResponse {
  readonly id: string;
  readonly paymentId: string;
  readonly status: PrismaPaymentAttempt['status'];
  readonly providerReference?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPaymentAttemptResponse(
  attempt: PrismaPaymentAttempt,
): PaymentAttemptResponse {
  return {
    id: attempt.id,
    paymentId: attempt.paymentId,
    status: attempt.status,
    providerReference: attempt.providerReference ?? undefined,
    failureReason: attempt.failureReason ?? undefined,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

export interface PaymentProofResponse {
  readonly id: string;
  readonly paymentId: string;
  readonly fileName: string;
  /**
   * An authenticated backend API route, never a raw storage URL — access
   * is re-checked by the exact same guards that govern the parent Payment
   * (`OrganizationMembershipGuard` or `PlatformOwnerGuard`), and the object
   * itself lives in a private bucket `PaymentProofStorageService` alone
   * addresses (see that class's own doc comment). Building this into a
   * fully-qualified URL is a deployment-configuration concern this phase
   * deliberately does not invent a new env var for — see the P12
   * implementation report.
   */
  readonly fileUrl: string;
  readonly mimeType: string;
  readonly note?: string;
  readonly uploadedAt: string;
}

export function toPaymentProofResponse(
  proof: PrismaPaymentProof,
  organizationId: string,
): PaymentProofResponse {
  return {
    id: proof.id,
    paymentId: proof.paymentId,
    fileName: proof.fileName,
    fileUrl: `/organizations/${organizationId}/payments/${proof.paymentId}/proof/file`,
    mimeType: proof.mimeType,
    note: proof.note ?? undefined,
    uploadedAt: proof.uploadedAt.toISOString(),
  };
}

/** Phase P13 — the Course Commerce analog of `toPaymentProofResponse` for a course-order Payment's proof, whose download route lives under `course-orders/:id/payments/:paymentId/proof/file` (no `organizationId` segment — Course Commerce payments have none, see `payments.organizationId`'s own P13 doc comment). Kept as its own function rather than an `organizationId?`-optional branch inside the one above, matching this module's existing precedent of one function per real, distinct route shape (`toPaymentResponse` vs. a future course-order variant, below). */
export function toCourseOrderPaymentProofResponse(
  proof: PrismaPaymentProof,
  courseOrderId: string,
): PaymentProofResponse {
  return {
    id: proof.id,
    paymentId: proof.paymentId,
    fileName: proof.fileName,
    fileUrl: `/course-orders/${courseOrderId}/payments/${proof.paymentId}/proof/file`,
    mimeType: proof.mimeType,
    note: proof.note ?? undefined,
    uploadedAt: proof.uploadedAt.toISOString(),
  };
}

export interface PaymentReviewResponse {
  readonly id: string;
  readonly paymentId: string;
  readonly status: PrismaPaymentReview['status'];
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly notes?: string;
}

export function toPaymentReviewResponse(
  review: PrismaPaymentReview,
): PaymentReviewResponse {
  return {
    id: review.id,
    paymentId: review.paymentId,
    status: review.status,
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt.toISOString(),
    notes: review.notes ?? undefined,
  };
}

export type PaymentNextActionResponse =
  | { readonly type: 'redirect'; readonly redirectUrl: string }
  | { readonly type: 'additional_authentication'; readonly description: string }
  | { readonly type: 'awaiting_manual_review' }
  | { readonly type: 'awaiting_proof' };

export interface PaymentResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly checkoutId: string;
  readonly methodKey: string;
  readonly methodType: PrismaPayment['methodType'];
  readonly provider: string;
  readonly money: MoneyResponse;
  readonly status: PrismaPayment['status'];
  readonly reviewStatus: PrismaPayment['reviewStatus'];
  readonly proof?: PaymentProofResponse;
  readonly attempts: readonly PaymentAttemptResponse[];
  readonly failureReason?: string;
  readonly reviewNotes?: string;
  readonly nextAction?: PaymentNextActionResponse;
  readonly providerReference?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export function toPaymentResponse(
  payment: PrismaPayment & {
    attempts?: PrismaPaymentAttempt[];
    proofs?: PrismaPaymentProof[];
  },
): PaymentResponse {
  const latestProof = [...(payment.proofs ?? [])].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
  )[0];

  return {
    id: payment.id,
    // Never null for an Atlas-subscription-billing row — `organizationId`
    // only became nullable in P13 to make room for Course Commerce's
    // `payerUserId`/`payeeAcademyId` pair on the SAME table (§5.7's
    // extension point); a course-order Payment is never routed through
    // this function (it has its own `toCourseOrderPaymentResponse`, P13),
    // so this fallback is defensive only, matching `checkoutId`'s own
    // identical, pre-existing precedent immediately below.
    organizationId: payment.organizationId ?? '',
    checkoutId: payment.checkoutId ?? '',
    methodKey: payment.methodKey,
    methodType: payment.methodType,
    provider: payment.provider,
    money: {
      amountMinorUnits: Number(payment.amountMinorUnits),
      currency: payment.currency,
    },
    status: payment.status,
    reviewStatus: payment.reviewStatus,
    proof: latestProof
      ? toPaymentProofResponse(latestProof, payment.organizationId ?? '')
      : undefined,
    attempts: (payment.attempts ?? [])
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toPaymentAttemptResponse),
    failureReason: payment.failureReason ?? undefined,
    reviewNotes: payment.reviewNotes ?? undefined,
    nextAction:
      (payment.nextAction as unknown as PaymentNextActionResponse | null) ?? undefined,
    providerReference: payment.providerReference ?? undefined,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    expiresAt: payment.expiresAt?.toISOString(),
  };
}
