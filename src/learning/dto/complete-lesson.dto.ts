/** `POST /courses/:id/progress/complete-lesson` request — matches `CompleteLessonPayload` (`progress.types.ts`) exactly. */
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Min } from 'class-validator';

export class CompleteLessonDto {
  @IsNotEmpty()
  @IsString()
  readonly lessonId!: string;

  /** See `LessonOpOrderingDto`. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  readonly opId?: string;

  /** See `LessonOpOrderingDto`. */
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly clientOpAt?: number;
}

/**
 * Academy offline work — ordering for lesson operations that may be sent
 * late from the offline outbox. Both optional (older clients send neither
 * and get the previous behaviour); both required for ordering to apply.
 * Shared by the complete body and the undo query string.
 */
export class LessonOpOrderingDto {
  /** The client's id for this one operation, reused on every retry of it. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  readonly opId?: string;

  /** When the learner acted, in epoch milliseconds on their device. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readonly clientOpAt?: number;
}
