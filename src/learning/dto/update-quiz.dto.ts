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
import {
  MAX_QUIZ_DESCRIPTION_LENGTH,
  MAX_QUIZ_QUESTIONS,
  MAX_QUIZ_TITLE_LENGTH,
  MIN_QUIZ_QUESTIONS,
} from './learning.constants';

const QUIZ_STATUS_VALUES = ['draft', 'published'] as const;

export class UpdateQuizDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_QUIZ_TITLE_LENGTH)
  readonly title?: string;

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

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  readonly passingScore?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  readonly maxAttempts?: number;

  @IsOptional()
  @ArrayMinSize(MIN_QUIZ_QUESTIONS)
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionInputDto)
  readonly questions?: readonly QuizQuestionInputDto[];
}
