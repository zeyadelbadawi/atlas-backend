/**
 * Instructor response contracts — match `instructor.types.ts` (atlas
 * frontend) field-for-field. Every shape here is a projection built from
 * real rows already owned by `CourseModule` (P5)/`LearningModule` (P6);
 * this module adds no new domain table of its own (see schema.prisma's P7
 * header comment).
 *
 * `AssignmentSubmissionReviewResponse` is the one place P7 legitimately
 * exposes the grading columns `assignment_submissions` has carried,
 * unused, since P6 (`gradingStatus`/`score`/`feedback`/`gradedAt`/
 * `gradedBy`) — the student-facing `AssignmentSubmissionResponse` (P6)
 * still omits them entirely; this is a separate contract, never a widened
 * version of that one.
 */
import type {
  AssignmentSubmission as PrismaAssignmentSubmission,
  CourseCompletionState,
  EnrollmentStatus,
  QuizAttempt as PrismaQuizAttempt,
} from '@prisma/client';
import { toQuizAttemptResponse } from '../../learning/dto/quiz-attempt.contract';
import type { QuizAttemptResponse } from '../../learning/dto/quiz-attempt.contract';
import type { CourseProgressResponse } from '../../learning/dto/course-progress.contract';

export type CourseAttentionReason =
  'pending_grading' | 'low_engagement' | 'no_recent_activity';

export interface CourseAttentionItemResponse {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly reason: CourseAttentionReason;
}

export type InstructorActivityType =
  'submission' | 'quiz_attempt' | 'enrollment' | 'completion';

export interface InstructorActivityItemResponse {
  readonly id: string;
  readonly type: InstructorActivityType;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly studentName?: string;
  readonly description: string;
  readonly timestamp: string;
}

export interface InstructorDashboardMetricsResponse {
  readonly assignedCoursesCount: number;
  readonly activeCoursesCount: number;
  readonly totalStudents: number;
  readonly pendingSubmissionsCount: number;
  readonly pendingGradingCount: number;
  readonly coursesRequiringAttention: readonly CourseAttentionItemResponse[];
  readonly recentActivity: readonly InstructorActivityItemResponse[];
}

export interface TeachingCourseResponse {
  readonly courseId: string;
  readonly title: string;
  readonly thumbnail?: string;
  readonly status: string;
  readonly visibility: string;
  readonly enrolledCount: number;
  readonly averageProgress?: number;
  readonly requiresAttention: boolean;
}

export interface InstructorCourseOverviewResponse {
  readonly courseId: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly visibility: string;
  readonly enrolledCount: number;
  readonly averageProgress?: number;
  readonly totalSections: number;
  readonly totalLessons: number;
  readonly pendingSubmissionsCount: number;
  readonly pendingGradingCount: number;
  readonly recentActivity: readonly InstructorActivityItemResponse[];
}

export interface InstructorStudentResponse {
  readonly studentId: string;
  readonly name: string;
  readonly email: string;
  readonly enrollmentStatus: EnrollmentStatus;
  readonly progressPercentage: number;
  readonly completionState: CourseCompletionState;
  readonly lastActivityAt?: string;
}

export interface QuizAttemptSummaryResponse extends QuizAttemptResponse {
  readonly studentName: string;
}

export function toQuizAttemptSummaryResponse(
  attempt: PrismaQuizAttempt,
  canRetry: boolean,
  studentName: string,
): QuizAttemptSummaryResponse {
  return { ...toQuizAttemptResponse(attempt, canRetry), studentName };
}

export type GradingStatus = 'ungraded' | 'graded';

export interface GradeResponse {
  readonly score?: number;
  readonly feedback?: string;
  readonly gradedAt?: string;
  readonly gradedBy?: string;
}

export interface AssignmentSubmissionReviewResponse {
  readonly id: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly status: PrismaAssignmentSubmission['status'];
  readonly response?: string;
  readonly attachmentUrl?: string;
  readonly submittedAt?: string;
  readonly gradingStatus: GradingStatus;
  readonly grade?: GradeResponse;
}

export function toAssignmentSubmissionReviewResponse(
  submission: PrismaAssignmentSubmission,
  studentName: string,
): AssignmentSubmissionReviewResponse {
  const hasGrade = submission.gradingStatus === 'graded';
  return {
    id: submission.id,
    assignmentId: submission.assignmentId,
    studentId: submission.studentId,
    studentName,
    status: submission.status,
    response: submission.response ?? undefined,
    attachmentUrl: submission.attachmentUrl ?? undefined,
    submittedAt: submission.submittedAt?.toISOString(),
    gradingStatus: submission.gradingStatus,
    grade: hasGrade
      ? {
          score: submission.score !== null ? Number(submission.score) : undefined,
          feedback: submission.feedback ?? undefined,
          gradedAt: submission.gradedAt?.toISOString(),
          gradedBy: submission.gradedBy ?? undefined,
        }
      : undefined,
  };
}

/** `InstructorStudentProgress` — read-only, reuses `CourseProgressResponse` (P6) and `QuizAttemptResponse` (P6) verbatim; only submissions gain grading state via `AssignmentSubmissionReviewResponse`, matching the frontend type's own framing exactly. */
export interface InstructorStudentProgressResponse {
  readonly studentId: string;
  readonly studentName: string;
  readonly courseId: string;
  readonly enrollmentStatus: EnrollmentStatus;
  readonly progress: CourseProgressResponse;
  readonly quizAttempts: readonly QuizAttemptResponse[];
  readonly assignmentSubmissions: readonly AssignmentSubmissionReviewResponse[];
}
