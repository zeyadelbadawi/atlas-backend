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
import { IsIn, IsOptional, Matches, MaxLength } from 'class-validator';
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

/** Payment lifecycle states (`PaymentLifecycleStatus`), all filterable on the Platform lists. */
export const PLATFORM_PAYMENT_STATUS_FILTERS = [
  'created',
  'pending',
  'processing',
  'requires_action',
  'requires_confirmation',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const;

/** `PaymentMethodType`, all filterable on the Platform lists. */
export const PLATFORM_PAYMENT_METHOD_TYPE_FILTERS = [
  'manual_bank_transfer',
  'manual_wallet_transfer',
  'manual_instapay',
  'gateway',
] as const;

/** `sortBy` allow-list — it selects an ORDER BY column. `amount` is `amount_minor_units`. */
export const PLATFORM_PAYMENT_SORT_FIELDS = ['createdAt', 'updatedAt', 'amount'] as const;
export type PlatformPaymentSortField = (typeof PLATFORM_PAYMENT_SORT_FIELDS)[number];

const PLATFORM_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `GET /payments` and `GET /platform-course-order-payments` (Platform Owner
 * review lists) — the tenant list's query plus the filters a cross-tenant
 * review queue needs. Kept as its own class so the tenant's
 * `GET organizations/:id/payments` does not start accepting parameters it
 * would silently ignore.
 *
 * `from`/`to` are calendar dates (`YYYY-MM-DD`), inclusive, in UTC, on the
 * payment's creation time. `search` matches the payment id (exact), the
 * provider reference, the method key/provider, and the organization name
 * (subscription list) or academy name / course title (course list).
 */
export class PlatformPaymentListQueryDto extends PaymentListQueryDto {
  @IsOptional()
  @IsIn(PLATFORM_PAYMENT_STATUS_FILTERS)
  readonly status?: (typeof PLATFORM_PAYMENT_STATUS_FILTERS)[number];

  @IsOptional()
  @IsIn(PLATFORM_PAYMENT_METHOD_TYPE_FILTERS)
  readonly methodType?: (typeof PLATFORM_PAYMENT_METHOD_TYPE_FILTERS)[number];

  @IsOptional()
  @Matches(PLATFORM_ISO_DATE, { message: 'validation:date' })
  readonly from?: string;

  @IsOptional()
  @Matches(PLATFORM_ISO_DATE, { message: 'validation:date' })
  readonly to?: string;

  @IsOptional()
  @IsIn(PLATFORM_PAYMENT_SORT_FIELDS)
  declare readonly sortBy?: PlatformPaymentSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}
