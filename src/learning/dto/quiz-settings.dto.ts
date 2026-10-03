/**
 * P64 Phase 3 (§D.1) — the quiz settings an author may set. Every field is
 * optional on the wire; an omitted field keeps the column's default (which
 * reproduces the pre-Phase-3 behaviour) or, on update, its current value.
 * Cross-field validation (window order, questions-per-attempt bounds,
 * exam-mode sanity) lives in `QuizzesService.assertValidSettings`.
 */
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const QUIZ_MODE_VALUES = ['practice', 'exam'] as const;
export const QUIZ_LAYOUT_VALUES = ['all_questions', 'one_per_page'] as const;
export const QUIZ_GRADING_POLICY_VALUES = [
  'highest',
  'latest',
  'first',
  'average',
] as const;
export const QUIZ_DISCLOSURE_VALUES = [
  'immediately',
  'after_due',
  'after_attempts_exhausted',
  'never',
] as const;
export const QUIZ_INTEGRITY_MODE_VALUES = ['off', 'monitor', 'warn', 'strict'] as const;
export const ASSESSMENT_LATE_POLICY_VALUES = ['block', 'accept_flagged'] as const;

export const MIN_TIME_LIMIT_SECONDS = 60;
export const MAX_TIME_LIMIT_SECONDS = 24 * 60 * 60;
export const MAX_VIOLATIONS_LIMIT = 50;

/**
 * W7 — "present or absent, never null" for NOT NULL columns. `@IsOptional()`
 * skips validation for `null` as well as `undefined`, so a `null` sent for a
 * NOT NULL setting used to reach Prisma and fail as a 500. With this, an
 * omitted field is still skipped (keeps its value), but `null` is validated
 * by the field's other decorators and refused as a 400. Fields whose
 * columns ARE nullable keep `@IsOptional()`: there `null` means "clear".
 */
export const IsOptionalNotNull = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

export class QuizSettingsFieldsDto {
  @IsOptionalNotNull()
  @IsIn(QUIZ_MODE_VALUES)
  readonly mode?: (typeof QUIZ_MODE_VALUES)[number];

  /** `null` clears the limit. */
  @IsOptional()
  @IsInt()
  @Min(MIN_TIME_LIMIT_SECONDS)
  @Max(MAX_TIME_LIMIT_SECONDS)
  readonly timeLimitSeconds?: number | null;

  @IsOptional()
  @IsDateString()
  readonly availableFrom?: string | null;

  @IsOptional()
  @IsDateString()
  readonly availableUntil?: string | null;

  @IsOptional()
  @IsDateString()
  readonly dueAt?: string | null;

  @IsOptionalNotNull()
  @IsIn(ASSESSMENT_LATE_POLICY_VALUES)
  readonly latePolicy?: (typeof ASSESSMENT_LATE_POLICY_VALUES)[number];

  @IsOptionalNotNull()
  @IsIn(QUIZ_GRADING_POLICY_VALUES)
  readonly gradingPolicy?: (typeof QUIZ_GRADING_POLICY_VALUES)[number];

  @IsOptionalNotNull()
  @IsBoolean()
  readonly shuffleQuestions?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  readonly shuffleOptions?: boolean;

  @IsOptional()
  @IsInt()
  @IsPositive()
  readonly questionsPerAttempt?: number | null;

  @IsOptionalNotNull()
  @IsIn(QUIZ_LAYOUT_VALUES)
  readonly layout?: (typeof QUIZ_LAYOUT_VALUES)[number];

  @IsOptionalNotNull()
  @IsIn(QUIZ_DISCLOSURE_VALUES)
  readonly showScore?: (typeof QUIZ_DISCLOSURE_VALUES)[number];

  @IsOptionalNotNull()
  @IsIn(QUIZ_DISCLOSURE_VALUES)
  readonly showAnswers?: (typeof QUIZ_DISCLOSURE_VALUES)[number];

  @IsOptionalNotNull()
  @IsBoolean()
  readonly showExplanations?: boolean;

  @IsOptionalNotNull()
  @IsIn(QUIZ_INTEGRITY_MODE_VALUES)
  readonly integrityMode?: (typeof QUIZ_INTEGRITY_MODE_VALUES)[number];

  @IsOptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(MAX_VIOLATIONS_LIMIT)
  readonly maxViolations?: number;

  @IsOptionalNotNull()
  @IsBoolean()
  readonly requireFullscreen?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  readonly requiredToProgress?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  readonly requiredForCompletion?: boolean;

  @IsOptionalNotNull()
  @IsBoolean()
  readonly hideTimer?: boolean;
}

/** The persisted settings in one place, so create/update/snapshot share a shape. */
export type QuizSettingsInput = {
  readonly [K in keyof QuizSettingsFieldsDto]-?: QuizSettingsFieldsDto[K];
};

export function toDateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}
