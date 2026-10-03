/**
 * `GET academies/:id/course-orders` query — the shared collection query
 * (page, pageSize ≤ 100, search, sort) plus the filters the academy Orders
 * page offers.
 *
 * - `status` filters the order itself.
 * - `paymentStatus`/`reviewStatus`/`methodType` match an order that has AT
 *   LEAST ONE payment in that state (an order can carry several payment
 *   attempts, e.g. a rejected transfer followed by an approved one).
 * - `refundStatus` matches the order's refund row; `none` means no refund
 *   was ever requested.
 * - `from`/`to` are calendar dates (`YYYY-MM-DD`), inclusive, in UTC, on
 *   the order's creation time.
 * - `search` matches the order id (exact), the course title, or the
 *   student's name or email (case-insensitive).
 *
 * `sortBy` is an allow-list because it selects an ORDER BY expression.
 * The global `ValidationPipe` runs `forbidNonWhitelisted: true`, so every
 * key the page sends is declared here.
 */
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export const COURSE_ORDER_STATUS_VALUES = [
  'draft',
  'pending_payment',
  'paid',
  'expired',
  'cancelled',
  'refunded',
] as const;

export const PAYMENT_STATUS_VALUES = [
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

export const PAYMENT_REVIEW_STATUS_VALUES = [
  'not_required',
  'pending',
  'approved',
  'rejected',
] as const;

export const PAYMENT_METHOD_TYPE_VALUES = [
  'manual_bank_transfer',
  'manual_wallet_transfer',
  'manual_instapay',
  'gateway',
] as const;

export const COURSE_ORDER_REFUND_FILTER_VALUES = [
  'none',
  'pending',
  'succeeded',
  'failed',
] as const;

export const ACADEMY_COURSE_ORDER_SORT_FIELDS = [
  'createdAt',
  'paidAt',
  'amount',
] as const;

export type AcademyCourseOrderSortField =
  (typeof ACADEMY_COURSE_ORDER_SORT_FIELDS)[number];

/** `YYYY-MM-DD` — shared with the platform payment list query. */
export const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AcademyCourseOrderQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(COURSE_ORDER_STATUS_VALUES)
  readonly status?: (typeof COURSE_ORDER_STATUS_VALUES)[number];

  @IsOptional()
  @IsIn(PAYMENT_STATUS_VALUES)
  readonly paymentStatus?: (typeof PAYMENT_STATUS_VALUES)[number];

  @IsOptional()
  @IsIn(PAYMENT_REVIEW_STATUS_VALUES)
  readonly reviewStatus?: (typeof PAYMENT_REVIEW_STATUS_VALUES)[number];

  @IsOptional()
  @IsIn(PAYMENT_METHOD_TYPE_VALUES)
  readonly methodType?: (typeof PAYMENT_METHOD_TYPE_VALUES)[number];

  @IsOptional()
  @IsIn(COURSE_ORDER_REFUND_FILTER_VALUES)
  readonly refundStatus?: (typeof COURSE_ORDER_REFUND_FILTER_VALUES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly courseId?: string;

  @IsOptional()
  @Matches(ISO_CALENDAR_DATE, { message: 'validation:date' })
  readonly from?: string;

  @IsOptional()
  @Matches(ISO_CALENDAR_DATE, { message: 'validation:date' })
  readonly to?: string;

  @IsOptional()
  @IsIn(ACADEMY_COURSE_ORDER_SORT_FIELDS)
  declare readonly sortBy?: AcademyCourseOrderSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}

/** Inclusive UTC calendar-date range → `[gte, lt)` instants. Invalid dates were already refused by the DTO's pattern; an impossible date (`2026-02-31`) yields `undefined` rather than `Invalid Date`. */
export function toCreatedAtRange(
  from?: string,
  to?: string,
): { gte?: Date; lt?: Date } | undefined {
  const start = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
  const end = to ? new Date(`${to}T00:00:00.000Z`) : undefined;
  const gte = start && !Number.isNaN(start.getTime()) ? start : undefined;
  const lt =
    end && !Number.isNaN(end.getTime())
      ? new Date(end.getTime() + 24 * 60 * 60 * 1000)
      : undefined;
  if (!gte && !lt) return undefined;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}
