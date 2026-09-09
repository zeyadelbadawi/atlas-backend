/**
 * Nested request shapes for `CreateQuizDto`/`UpdateQuizDto` (Phase 4, P24)
 * — one question with its options, authored in one atomic quiz-save
 * action (see `QuizzesService.createQuiz`'s doc comment for why quiz
 * authoring is "whole quiz, replace-all-questions" rather than granular
 * per-question CRUD like `CourseSection`/`CourseLesson`).
 *
 * `isCorrect` is real request input here — the one and only place in
 * this codebase's DTOs it legitimately appears at all (contrast
 * `quiz.contract.ts`'s `QuizQuestionOptionResponse`, which structurally
 * never carries it). Cross-field rules the scoring engine actually
 * depends on (single_choice/true_false need exactly one correct option;
 * multiple_choice needs at least one; true_false needs exactly two
 * options) are enforced in `QuizzesService`, not here — the same "a plain
 * class-validator decorator can't express this cleanly" reasoning
 * `CreateAssignmentSubmissionDto`'s own doc comment already documents.
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MAX_QUIZ_OPTION_LABEL_LENGTH,
  MAX_QUIZ_OPTIONS_PER_QUESTION,
  MAX_QUIZ_QUESTION_PROMPT_LENGTH,
} from './learning.constants';

const QUIZ_QUESTION_TYPE_VALUES = [
  'single_choice',
  'multiple_choice',
  'true_false',
] as const;

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

  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_QUIZ_OPTIONS_PER_QUESTION)
  @ValidateNested({ each: true })
  @Type(() => QuizQuestionOptionInputDto)
  readonly options!: readonly QuizQuestionOptionInputDto[];
}
