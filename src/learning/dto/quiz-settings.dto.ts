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

export class QuizSettingsFieldsDto {
  @IsOptional()
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

  @IsOptional()
  @IsIn(ASSESSMENT_LATE_POLICY_VALUES)
  readonly latePolicy?: (typeof ASSESSMENT_LATE_POLICY_VALUES)[number];

  @IsOptional()
  @IsIn(QUIZ_GRADING_POLICY_VALUES)
  readonly gradingPolicy?: (typeof QUIZ_GRADING_POLICY_VALUES)[number];

  @IsOptional()
  @IsBoolean()
  readonly shuffleQuestions?: boolean;

  @IsOptional()
  @IsBoolean()
  readonly shuffleOptions?: boolean;

  @IsOptional()
  @IsInt()
  @IsPositive()
  readonly questionsPerAttempt?: number | null;

  @IsOptional()
  @IsIn(QUIZ_LAYOUT_VALUES)
  readonly layout?: (typeof QUIZ_LAYOUT_VALUES)[number];

  @IsOptional()
  @IsIn(QUIZ_DISCLOSURE_VALUES)
  readonly showScore?: (typeof QUIZ_DISCLOSURE_VALUES)[number];

  @IsOptional()
  @IsIn(QUIZ_DISCLOSURE_VALUES)
  readonly showAnswers?: (typeof QUIZ_DISCLOSURE_VALUES)[number];

  @IsOptional()
  @IsBoolean()
  readonly showExplanations?: boolean;

  @IsOptional()
  @IsIn(QUIZ_INTEGRITY_MODE_VALUES)
  readonly integrityMode?: (typeof QUIZ_INTEGRITY_MODE_VALUES)[number];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VIOLATIONS_LIMIT)
  readonly maxViolations?: number;

  @IsOptional()
  @IsBoolean()
  readonly requireFullscreen?: boolean;

  @IsOptional()
  @IsBoolean()
  readonly requiredToProgress?: boolean;

  @IsOptional()
  @IsBoolean()
  readonly requiredForCompletion?: boolean;

  @IsOptional()
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
