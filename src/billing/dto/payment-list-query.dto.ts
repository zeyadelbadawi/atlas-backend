/**
 * `GET organizations/:id/payments` / `GET /payments` query contract — the
 * shared `CollectionQuery` base plus `reviewStatus`, the one typed filter
 * either list actually needs (`payment.types.ts`'s `ManualReviewStatus`).
 *
 * `reviewStatus` is real everywhere already — `ManualReviewStatus`
 * (Prisma enum, `Payment.reviewStatus` column) is what `approvePayment`/
 * `rejectPayment` already read and write — but no query field ever
 * exposed it for reading, so the frontend's own Platform Payment Review
 * page (its default filter is literally "pending", the whole point of a
 * review queue) could never actually filter by it: `ValidationPipe`'s
 * `forbidNonWhitelisted: true` rejected `?reviewStatus=pending` outright
 * (confirmed live: `GET /payments?reviewStatus=pending` → 400,
 * `"property reviewStatus should not exist"`). `not_required` is
 * deliberately excluded — it marks a Payment that was never subject to
 * manual review at all (see `PaymentService.getPayments`'s own comment),
 * not a state either reviewer-facing list has any reason to filter to.
 */
import { IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** Matches `ManualReviewStatus`'s reviewer-relevant values (Prisma enum minus `not_required`). */
export const REVIEWABLE_PAYMENT_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const;

export type ReviewablePaymentReviewStatus =
  (typeof REVIEWABLE_PAYMENT_REVIEW_STATUSES)[number];

export class PaymentListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(REVIEWABLE_PAYMENT_REVIEW_STATUSES)
  readonly reviewStatus?: ReviewablePaymentReviewStatus;
}
