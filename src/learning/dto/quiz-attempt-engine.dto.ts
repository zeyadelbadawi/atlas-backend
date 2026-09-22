/**
 * P64 Phase 3 — request bodies of the v2 attempt lifecycle.
 *
 * Answers carry EITHER selected option ids (choice questions) OR text
 * (short answer / essay); the engine validates the shape against the
 * question type, never the DTO alone. Every list is capped so a client
 * cannot post an unbounded payload.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_ESSAY_LENGTH, MAX_EVENTS_PER_BATCH } from '../services/quiz-engine.util';
import { MAX_QUIZ_QUESTIONS } from './learning.constants';

export class AttemptAnswerDto {
  @IsNotEmpty()
  @IsString()
  readonly questionId!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  readonly selectedOptionIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ESSAY_LENGTH)
  readonly text?: string;
}

export class SaveQuizAnswersDto {
  /** Monotonic per attempt; a stale revision is ignored, never applied. */
  @IsInt()
  @Min(1)
  readonly revision!: number;

  @IsArray()
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => AttemptAnswerDto)
  readonly answers!: AttemptAnswerDto[];
}

export class SubmitQuizAttemptV2Dto {
  /** Optional final answer set; when absent the last server-confirmed answers are graded. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => AttemptAnswerDto)
  readonly answers?: AttemptAnswerDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  readonly revision?: number;
}

export const QUIZ_ATTEMPT_EVENT_TYPES = [
  'visibility_hidden',
  'visibility_visible',
  'blur',
  'focus',
  'fullscreen_exit',
  'fullscreen_enter',
  'copy',
  'paste',
  'cut',
  'contextmenu',
  'print',
  'heartbeat',
  'second_session',
  'device_change',
  'warning_acknowledged',
] as const;

export class QuizAttemptEventDto {
  @IsIn(QUIZ_ATTEMPT_EVENT_TYPES)
  readonly type!: (typeof QUIZ_ATTEMPT_EVENT_TYPES)[number];

  /** The client's own clock — recorded for the timeline, never trusted for order or escalation. */
  @IsOptional()
  @IsDateString()
  readonly clientAt?: string;

  @IsOptional()
  @IsObject()
  readonly payload?: Record<string, unknown>;
}

export class RecordQuizAttemptEventsDto {
  @IsArray()
  @ArrayMaxSize(MAX_EVENTS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => QuizAttemptEventDto)
  readonly events!: QuizAttemptEventDto[];
}

export class GradeQuizAttemptQuestionDto {
  @IsNotEmpty()
  @IsString()
  readonly questionId!: string;

  @IsInt()
  @Min(0)
  readonly points!: number;
}

export class GradeQuizAttemptDto {
  @IsArray()
  @ArrayMaxSize(MAX_QUIZ_QUESTIONS)
  @ValidateNested({ each: true })
  @Type(() => GradeQuizAttemptQuestionDto)
  readonly grades!: GradeQuizAttemptQuestionDto[];
}

export class InvalidateQuizAttemptDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  readonly reason!: string;
}

export class QuizStudentOverrideDto {
  @IsNotEmpty()
  @IsString()
  readonly studentId!: string;

  /** 1 = no extra time; 1.5 = time and a half; capped at 4. */
  @IsOptional()
  @Type(() => Number)
  readonly timeMultiplier?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  readonly extraAttempts?: number;

  @IsOptional()
  @IsDateString()
  readonly availableFrom?: string | null;

  @IsOptional()
  @IsDateString()
  readonly availableUntil?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reason?: string;
}
