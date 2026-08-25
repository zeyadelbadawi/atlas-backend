/**
 * `POST courses/:id/assignments/:assignmentId/submissions/:submissionId/grade`
 * request — matches `GradeSubmissionPayload` (`instructor.types.ts`)
 * exactly: "Only the fields the instructor enters — no scoring logic."
 * `score` is a 0–100 percentage, matching the `Decimal(5,2)` column and
 * `QuizAttempt.score`'s identical established range/precision in this
 * codebase (P6) — the frontend collects a plain number with no documented
 * range, so this is the same reasonable default already applied there.
 */
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GradeSubmissionDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  readonly score?: number;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  readonly feedback?: string;
}
