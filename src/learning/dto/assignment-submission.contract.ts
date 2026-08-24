/**
 * `AssignmentSubmission` response contract — matches `assignment.types.ts`
 * field-for-field. Deliberately omits the grading columns
 * (`gradingStatus`/`score`/`feedback`/`gradedAt`/`gradedBy`) — the
 * student-facing `AssignmentSubmission` type has no such field; grading is
 * Instructor Operations (P7) scope, projected through its own
 * `AssignmentSubmissionReview` contract there, not here.
 */
import type { AssignmentSubmission as PrismaAssignmentSubmission } from '@prisma/client';

export interface AssignmentSubmissionResponse {
  readonly id: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly status: PrismaAssignmentSubmission['status'];
  readonly response?: string;
  readonly attachmentUrl?: string;
  readonly submittedAt?: string;
}

export function toAssignmentSubmissionResponse(
  submission: PrismaAssignmentSubmission,
): AssignmentSubmissionResponse {
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    studentId: submission.studentId,
    status: submission.status,
    response: submission.response ?? undefined,
    attachmentUrl: submission.attachmentUrl ?? undefined,
    submittedAt: submission.submittedAt?.toISOString(),
  };
}
