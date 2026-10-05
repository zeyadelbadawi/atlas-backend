/**
 * `GET academies/:id/course-payments` query — the Client Owner's review
 * list of payments learners made to THIS academy with its own manual
 * methods (Academy Manual Payments).
 *
 * - `reviewStatus` — `pending` (waiting for review), `approved`, `rejected`.
 *   Payments still waiting for the learner's proof are not review work and
 *   are never listed.
 * - `methodType` — one of the three manual types.
 * - `from`/`to` — calendar dates, inclusive, UTC, on the payment's creation.
 * - `search` — the payment id or order id (exact), the course title, the
 *   learner's name (contains) or exact email, or the payer's reference.
 *
 * The global `ValidationPipe` runs `forbidNonWhitelisted: true`, so every
 * key the page sends is declared here.
 */
import { IsIn, IsOptional, Matches, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { ISO_CALENDAR_DATE } from './academy-course-order-query.dto';

export const ACADEMY_COURSE_PAYMENT_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const;
export type AcademyCoursePaymentReviewStatus =
  (typeof ACADEMY_COURSE_PAYMENT_REVIEW_STATUSES)[number];

export const ACADEMY_COURSE_PAYMENT_METHOD_TYPES = [
  'manual_bank_transfer',
  'manual_instapay',
  'manual_wallet_transfer',
] as const;

export const ACADEMY_COURSE_PAYMENT_SORT_FIELDS = ['createdAt', 'amount'] as const;

export class AcademyCoursePaymentQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(ACADEMY_COURSE_PAYMENT_REVIEW_STATUSES)
  readonly reviewStatus?: AcademyCoursePaymentReviewStatus;

  @IsOptional()
  @IsIn(ACADEMY_COURSE_PAYMENT_METHOD_TYPES)
  readonly methodType?: (typeof ACADEMY_COURSE_PAYMENT_METHOD_TYPES)[number];

  @IsOptional()
  @Matches(ISO_CALENDAR_DATE, { message: 'validation:date' })
  readonly from?: string;

  @IsOptional()
  @Matches(ISO_CALENDAR_DATE, { message: 'validation:date' })
  readonly to?: string;

  @IsOptional()
  @IsIn(ACADEMY_COURSE_PAYMENT_SORT_FIELDS)
  declare readonly sortBy?: (typeof ACADEMY_COURSE_PAYMENT_SORT_FIELDS)[number];

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}
