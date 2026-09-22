import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MAX_QUIZ_OPTION_LABEL_LENGTH,
  MAX_QUIZ_OPTIONS_PER_QUESTION,
  MAX_QUIZ_QUESTION_PROMPT_LENGTH,
} from './learning.constants';

/**
 * P64 Phase 3 — two new question types. `short_answer` carries the accepted
 * answers (matched normalised, never shown to the learner before the
 * disclosure policy allows); `essay` is graded manually by a reviewer.
 * Choice questions still carry 2–N options; text questions carry none.
 * Cross-field rules (option counts per type, correct-option counts) stay in
 * `QuizzesService.assertValidQuestions`, exactly where they were.
 */
export const QUIZ_QUESTION_TYPE_VALUES = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'short_answer',
  'essay',
] as const;

export const MAX_QUESTION_POINTS = 100;
export const MAX_ACCEPTED_ANSWERS = 20;
export const MAX_ACCEPTED_ANSWER_LENGTH = 200;
export const MAX_EXPLANATION_LENGTH = 2_000;

export class QuizQuestionOptionInputDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_QUIZ_OPTION_LABEL_LENGTH)
  readonly label!: string;

  @IsBoolean()
  readonly isCorrect!: boolean;
}

export class QuizQuestionInputDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_QUIZ_QUESTION_PROMPT_LENGTH)
  readonly prompt!: string;

  @IsIn(QUIZ_QUESTION_TYPE_VALUES)
  readonly type!: (typeof QUIZ_QUESTION_TYPE_VALUES)[number];

  @IsOptional()
  @ArrayMinSize(0)
  @ArrayMaxSize(MAX_QUIZ_OPTIONS_PER_QUESTION)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionOptionInputDto)
  readonly options?: readonly QuizQuestionOptionInputDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_QUESTION_POINTS)
  readonly points?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_EXPLANATION_LENGTH)
  readonly explanation?: string;

  @IsOptional()
  @IsString()
  readonly relatedLessonId?: string;

  @IsOptional()
  @ArrayMaxSize(MAX_ACCEPTED_ANSWERS)
  @IsString({ each: true })
  @MaxLength(MAX_ACCEPTED_ANSWER_LENGTH, { each: true })
  readonly acceptedAnswers?: readonly string[];
}
