/**
 * `POST /courses/:id/quizzes` request (Phase 4, P24). The full quiz —
 * fields plus its complete question/option set — is authored in one
 * atomic action; there is no separate "create quiz shell, then add
 * questions one at a time" flow, matching the Quiz Builder UI this
 * backs (one form, one save).
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsInt,
  IsNotEmpty,
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
import {
  MAX_QUIZ_DESCRIPTION_LENGTH,
  MAX_QUIZ_QUESTIONS,
  MAX_QUIZ_TITLE_LENGTH,
  MIN_QUIZ_QUESTIONS,
} from './learning.constants';

const QUIZ_STATUS_VALUES = ['draft', 'published'] as const;

export class CreateQuizDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_QUIZ_TITLE_LENGTH)
  readonly title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUIZ_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsString()
  readonly sectionId?: string;

  @IsOptional()
  @IsIn(QUIZ_STATUS_VALUES)
  readonly status?: (typeof QUIZ_STATUS_VALUES)[number];

  /** 0-100. `undefined` means no passing threshold — every submitted attempt passes, matching `isAttemptPassing`'s existing `null` semantics exactly (unchanged). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  readonly passingScore?: number;

  /** `undefined` means unlimited attempts, matching `canStartAnotherAttempt`'s existing `null` semantics exactly (unchanged). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  readonly maxAttempts?: number;

  @ArrayMinSize(MIN_QUIZ_QUESTIONS)
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionInputDto)
  readonly questions!: readonly QuizQuestionInputDto[];
}
