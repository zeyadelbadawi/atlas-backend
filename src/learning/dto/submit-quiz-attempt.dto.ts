/** `POST /courses/:id/quizzes/:quizId/attempts/:attemptId/submit` request — matches `SubmitQuizAttemptPayload` (`quiz.types.ts`) exactly. */
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

export class QuizAnswerDto {
  @IsNotEmpty()
  @IsString()
  readonly questionId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  readonly selectedOptionIds!: string[];
}

export class SubmitQuizAttemptDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => QuizAnswerDto)
  readonly answers!: QuizAnswerDto[];
}
