/**
 * `StudentResults` response contract — Phase 9's "My Results" surface.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
 * `StudentMyLearningPage` already shows a student's course PROGRESS
 * (percentage, completed/total lessons, certificate status) from
 * `GET /enrollments`. This surface is the OUTCOMES half the roadmap
 * found missing — quiz scores and assignment grades — with just enough
 * progress carried alongside to give each result its course context. It
 * is not a second My Learning, and it re-uses the same already-computed
 * `CourseProgress` figures rather than recomputing progress a second way.
 *
 * HONESTY RULES, in the same spirit as Phase 8's revenue contract:
 *   - `averageQuizScore` is `null`, never `0`, when the student has no
 *     scored attempt. "No data" and "scored zero" are different facts and
 *     the UI must be able to tell them apart.
 *   - `score` on an individual result is `null` when that attempt or
 *     submission genuinely has no score yet (submitted but ungraded).
 *   - `passed` is `null` when the quiz defines no passing score at all,
 *     rather than being coerced to `false`.
 *
 * PRIVACY. Every field here belongs to the requesting student. There is
 * deliberately no field for a peer's score, a cohort average, a rank, or
 * a quiz question's correct answer — a student must never learn the
 * correct answers from their own results view, and `QuizQuestionOption.
 * isCorrect` is never read on this path.
 */

export interface StudentQuizResultResponse {
  readonly attemptId: string;
  readonly quizId: string;
  readonly quizTitle: string;
  readonly attemptNumber: number;
  /** Percentage 0–100. `null` when the attempt is submitted but not yet scored. */
  readonly score: number | null;
  /** `null` when the quiz sets no passing score — never coerced to `false`. */
  readonly passed: boolean | null;
  readonly submittedAt: string | null;
}

export interface StudentAssignmentResultResponse {
  readonly submissionId: string;
  readonly assignmentId: string;
  readonly assignmentTitle: string;
  readonly status: string;
  readonly gradingStatus: string;
  /** `null` while ungraded. */
  readonly score: number | null;
  readonly hasFeedback: boolean;
  readonly submittedAt: string | null;
  readonly gradedAt: string | null;
}

export interface StudentCourseResultsResponse {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly academyId: string;
  /** The same materialized `CourseProgress` the My Learning page reads; `null` when the row does not exist yet. */
  readonly progress: {
    readonly completedLessons: number;
    readonly totalLessons: number;
    readonly percentage: number;
    readonly completionState: string;
  } | null;
  readonly quizResults: readonly StudentQuizResultResponse[];
  readonly assignmentResults: readonly StudentAssignmentResultResponse[];
}

export interface StudentResultsSummaryResponse {
  readonly coursesEnrolled: number;
  readonly coursesCompleted: number;
  readonly quizzesAttempted: number;
  readonly quizzesPassed: number;
  readonly assignmentsSubmitted: number;
  readonly assignmentsGraded: number;
  /** Mean of every SCORED attempt, rounded to one decimal. `null` when none are scored — see this file's honesty rules. */
  readonly averageQuizScore: number | null;
}

export interface StudentResultsResponse {
  readonly summary: StudentResultsSummaryResponse;
  readonly courses: readonly StudentCourseResultsResponse[];
}
