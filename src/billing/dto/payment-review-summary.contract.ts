/**
 * B8 (UX audit) V01 — "Reviewed by <name> on <date>" on the Platform
 * payment detail.
 *
 * The latest manual-review decision on a payment: what was decided, when,
 * and the reviewer's display name (never the email). Absent until someone
 * reviews the payment. `reviewerName` is absent when the reviewer's
 * account no longer exists.
 */
import type { ManualReviewStatus } from '@prisma/client';
import type { LatestPaymentReview } from '../repositories/payments.repository';

export interface PaymentReviewSummaryResponse {
  readonly status: ManualReviewStatus;
  readonly reviewedAt: string;
  readonly reviewerName?: string;
}

export function toPaymentReviewSummary(
  reviews: readonly LatestPaymentReview[],
): PaymentReviewSummaryResponse | undefined {
  const latest = reviews[0];
  if (!latest) return undefined;
  return {
    status: latest.status,
    reviewedAt: latest.reviewedAt.toISOString(),
    reviewerName: latest.reviewer?.name ?? undefined,
  };
}
