import type { AssignmentSubmission as PrismaAssignmentSubmission } from '@prisma/client';

/** A protected attachment as the learner (or reviewer) may fetch it: a short-lived signed link. */
export interface SubmissionAttachmentResponse {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * P64 Phase 3 (§D.4) — the learner's own submission, now carrying the draft,
 * the late flag, the grading status and the grade + feedback (the plan's
 * "submission view exposing response, attachments, status timeline, grade
 * and feedback").
 */
export interface AssignmentSubmissionResponse {
  readonly id: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly status: PrismaAssignmentSubmission['status'];
  readonly response?: string;
  readonly attachmentUrl?: string;
  readonly attachment: SubmissionAttachmentResponse | null;
  readonly submittedAt?: string;
  readonly isLate: boolean;
  readonly draftResponse: string | null;
  readonly draftSavedAt: string | null;
  readonly submittedRevision: number;
  readonly gradingStatus: PrismaAssignmentSubmission['gradingStatus'];
  readonly grade: {
    readonly score: number | null;
    readonly feedback: string | null;
    readonly gradedAt: string | null;
  } | null;
}

export function toAssignmentSubmissionResponse(
  submission: PrismaAssignmentSubmission,
  attachment: SubmissionAttachmentResponse | null = null,
): AssignmentSubmissionResponse {
  const graded = submission.gradingStatus === 'graded';
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    studentId: submission.studentId,
    status: submission.status,
    response: submission.response ?? undefined,
    attachmentUrl: submission.attachmentUrl ?? undefined,
    attachment,
    submittedAt: submission.submittedAt?.toISOString(),
    isLate: submission.isLate,
    draftResponse: submission.draftResponse,
    draftSavedAt: submission.draftSavedAt?.toISOString() ?? null,
    submittedRevision: submission.submittedRevision,
    gradingStatus: submission.gradingStatus,
    grade: graded
      ? {
          score: submission.score !== null ? Number(submission.score) : null,
          feedback: submission.feedback,
          gradedAt: submission.gradedAt?.toISOString() ?? null,
        }
      : null,
  };
}
