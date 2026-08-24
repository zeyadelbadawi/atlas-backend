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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_ASSIGNMENT_RESPONSE_LENGTH } from './learning.constants';

export class CreateAssignmentSubmissionDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSIGNMENT_RESPONSE_LENGTH)
  readonly response?: string;

  @IsOptional()
  @IsString()
  readonly attachmentUrl?: string;
}
