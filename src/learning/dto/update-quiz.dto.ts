/**
 * `PATCH /courses/:id/quizzes/:quizId` request (Phase 4, P24). Every field
 * optional (a general field update, matching `UpdateCourseDto`'s own
 * shape) — but when `questions` is present, it REPLACES the quiz's
 * entire question/option set (see `QuizzesService.updateQuiz`'s doc
 * comment): there is no partial "just rename this one question" request
 * shape, matching `CreateQuizDto`'s identical one-form-one-save design.
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { QuizQuestionInputDto } from './quiz-question-input.dto';
import { IsOptionalNotNull, QuizSettingsFieldsDto } from './quiz-settings.dto';
import {
  MAX_QUIZ_DESCRIPTION_LENGTH,
  MAX_QUIZ_QUESTIONS,
  MAX_QUIZ_TITLE_LENGTH,
  MIN_QUIZ_QUESTIONS,
} from './learning.constants';

const QUIZ_STATUS_VALUES = ['draft', 'published'] as const;

export class UpdateQuizDto extends QuizSettingsFieldsDto {
  /** NOT NULL — omit to keep; `null` is refused (400), never a 500. */
  @IsOptionalNotNull()
  @IsString()
  @MaxLength(MAX_QUIZ_TITLE_LENGTH)
  readonly title?: string;

  /** W7 — `null` (or `''`) clears the description; omit to keep it. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUIZ_DESCRIPTION_LENGTH)
  readonly description?: string | null;

  /**
   * The unit this quiz sits in. Must be a unit of THIS course (checked in
   * `QuizzesService.updateQuiz`); moving to another unit appends the quiz at
   * that unit's end. `null` detaches it (it stays course-level content).
   */
  @IsOptional()
  @IsString()
  readonly sectionId?: string | null;

  @IsOptionalNotNull()
  @IsIn(QUIZ_STATUS_VALUES)
  readonly status?: (typeof QUIZ_STATUS_VALUES)[number];

  /** W7 — `null` clears the passing threshold (every submitted attempt passes); omit to keep it. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  readonly passingScore?: number | null;

  /** W7 — `null` clears the limit (unlimited attempts); omit to keep it. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  readonly maxAttempts?: number | null;

  @IsOptionalNotNull()
  @ArrayMinSize(MIN_QUIZ_QUESTIONS)
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionInputDto)
  readonly questions?: readonly QuizQuestionInputDto[];
}
