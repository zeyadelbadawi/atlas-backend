/**
 * B6 (UX audit) V17 — server-side filters for the instructor's review
 * lists.
 *
 * Paging is server-side, so a filter applied in the browser could only ever
 * narrow the one page it was given — "show me the attempts awaiting a
 * manual grade" would silently miss every one on page 2. These filters
 * travel with `page`/`pageSize` and are applied in the database query, so
 * `pagination.totalItems` counts the filtered rows.
 *
 * Every value is validated (the global pipe runs with
 * `forbidNonWhitelisted`): an unknown status or a boolean that is not
 * literally `true`/`false` is a 400 naming the field, never ignored.
 * `search` (inherited) matches the student's name, case-insensitive.
 */
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { withViolation } from '../../common/validation/violation-message';

export const QUIZ_ATTEMPT_STATUS_FILTERS = [
  'in_progress',
  'submitted',
  'passed',
  'failed',
  'expired',
  'invalidated',
] as const;
export type QuizAttemptStatusFilter = (typeof QUIZ_ATTEMPT_STATUS_FILTERS)[number];

export const QUIZ_ATTEMPT_GRADING_FILTERS = [
  'not_required',
  'pending',
  'graded',
] as const;
export type QuizAttemptGradingFilter = (typeof QUIZ_ATTEMPT_GRADING_FILTERS)[number];

export const SUBMISSION_GRADING_FILTERS = ['ungraded', 'graded'] as const;
export type SubmissionGradingFilter = (typeof SUBMISSION_GRADING_FILTERS)[number];

const INVALID_FILTER = withViolation('validation:invalid');

/** `?late=true` arrives as a string; only `true`/`false` are booleans — anything else stays as sent and fails `@IsBoolean`. */
const toStrictBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class QuizAttemptListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(QUIZ_ATTEMPT_STATUS_FILTERS, INVALID_FILTER)
  readonly status?: QuizAttemptStatusFilter;

  @IsOptional()
  @IsIn(QUIZ_ATTEMPT_GRADING_FILTERS, INVALID_FILTER)
  readonly gradingStatus?: QuizAttemptGradingFilter;

  /** Only attempts the integrity checks flagged (`true`) or did not flag (`false`). */
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean(INVALID_FILTER)
  readonly flagged?: boolean;

  /** Only late (`true`) or on-time (`false`) attempts. */
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean(INVALID_FILTER)
  readonly late?: boolean;
}

export class AssignmentSubmissionListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(SUBMISSION_GRADING_FILTERS, INVALID_FILTER)
  readonly gradingStatus?: SubmissionGradingFilter;

  /** Only late (`true`) or on-time (`false`) submissions. */
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean(INVALID_FILTER)
  readonly late?: boolean;
}
