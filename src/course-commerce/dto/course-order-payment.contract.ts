/**
 * `Payment` response contract for a Course Commerce row — the buyer/seller
 * analog of `PaymentResponse` (P12, `billing/dto/payment.contract.ts`).
 * Kept as its own type/mapper rather than reusing `toPaymentResponse`
 * directly: a course-order Payment has no `organizationId`/`checkoutId`
 * (structurally null, per the CHECK constraint) and carries fields
 * `PaymentResponse` has no use for (`payerUserId`/`payeeAcademyId`/
 * `courseOrderId`, the §4.2 commission snapshot) — reusing one response
 * shape for both would mean either a confusing all-optional union or a
 * response that lies about which fields are "really" present for which
 * flow. The underlying repository/attempt/proof mappers ARE reused
 * verbatim (`toPaymentAttemptResponse`, `toCourseOrderPaymentProofResponse`)
 * — only the top-level shape differs, matching this codebase's "share what
 * is genuinely shared, keep what is genuinely distinct separate" rule.
 */
import type {
  Payment as PrismaPayment,
  PaymentAttempt as PrismaPaymentAttempt,
  PaymentProof as PrismaPaymentProof,
} from '@prisma/client';
import type { MoneyResponse } from '../../billing/dto/checkout.contract';
import {
  toPaymentAttemptResponse,
  toCourseOrderPaymentProofResponse,
  type PaymentAttemptResponse,
  type PaymentNextActionResponse,
  type PaymentProofResponse,
} from '../../billing/dto/payment.contract';

export interface CourseOrderPaymentResponse {
  readonly id: string;
  readonly courseOrderId: string;
  readonly payerUserId: string;
  readonly payeeAcademyId: string;
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
  /** §4.1 snapshot — which payment-collection mode was effective when this Payment was created. Never recomputed. */
  readonly paymentCollectionModeSnapshot?: PrismaPayment['paymentCollectionModeSnapshot'];
  /** §4.2 snapshot — `null`/absent when Organization-Owned Gateway mode (no Atlas commission ever applies to that flow). */
  readonly commission?: {
    readonly rateBasisPoints: number;
    readonly amountMinorUnits: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export function toCourseOrderPaymentResponse(
  payment: PrismaPayment & {
    attempts?: PrismaPaymentAttempt[];
    proofs?: PrismaPaymentProof[];
  },
): CourseOrderPaymentResponse {
  const latestProof = [...(payment.proofs ?? [])].sort(
    (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
  )[0];

  return {
    id: payment.id,
    courseOrderId: payment.courseOrderId ?? '',
    payerUserId: payment.payerUserId ?? '',
    payeeAcademyId: payment.payeeAcademyId ?? '',
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
      ? toCourseOrderPaymentProofResponse(latestProof, payment.courseOrderId ?? '')
      : undefined,
    attempts: (payment.attempts ?? [])
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toPaymentAttemptResponse),
    failureReason: payment.failureReason ?? undefined,
    reviewNotes: payment.reviewNotes ?? undefined,
    nextAction:
      (payment.nextAction as unknown as PaymentNextActionResponse | null) ?? undefined,
    paymentCollectionModeSnapshot: payment.paymentCollectionModeSnapshot ?? undefined,
    commission:
      payment.commissionRateBasisPointsSnapshot != null &&
      payment.commissionAmountMinorUnits != null
        ? {
            rateBasisPoints: payment.commissionRateBasisPointsSnapshot,
            amountMinorUnits: Number(payment.commissionAmountMinorUnits),
          }
        : undefined,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
    expiresAt: payment.expiresAt?.toISOString(),
  };
}
