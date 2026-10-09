/**
 * `POST /courses/:id/assignments/:assignmentId/submission` request —
 * matches `CreateAssignmentSubmissionPayload` (`assignment.types.ts`)
 * exactly. The frontend's own `assignmentSubmissionSchema` requires at
 * least a response or an attachment (`learning.schemas.ts`'s `.refine()`)
 * — re-enforced server-side in `AssignmentsService.submitAssignment`
 * (a plain `class-validator` decorator can't express "at least one of
 * these two optional fields" cross-field cleanly), the same
 * "never trust the client-side check alone" discipline applied to
 * `CoursePricingInputDto` during the P5 closure pass.
 */
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { MAX_ASSIGNMENT_RESPONSE_LENGTH } from './learning.constants';

export class CreateAssignmentSubmissionDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_RESPONSE_LENGTH)
  readonly response?: string;

  /** Pre-Phase-3 public attachment URL; kept for compatibility, ignored when `attachmentAssetId` is set. */
  @IsOptional()
  @IsString()
  readonly attachmentUrl?: string;

  /** P64 Phase 3 (S12) — a protected asset the student uploaded themselves. */
  @IsOptional()
  @IsString()
  readonly attachmentAssetId?: string;

  /**
   * Academy offline work — the client's id for THIS submit action, reused on
   * every retry of it (including one replayed from the offline outbox). A
   * replay returns the original submission instead of submitting again.
   * Optional: older clients send none and behave exactly as before.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  readonly idempotencyKey?: string;

  /**
   * The `submittedRevision` the learner saw when they pressed Submit. If the
   * server has moved past it, this request is a replay of a submit that
   * already landed (or a submit made elsewhere since): it is never applied
   * again, so a grade given in between is never reset.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  readonly baseRevision?: number;
}
