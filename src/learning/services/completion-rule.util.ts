/**
 * P64 Phase 3 — the completion-rule evaluator (AD-11, findings F2/S7).
 *
 * Pure: it takes the course's rule and the EVIDENCE the server already
 * holds (lesson progress rows, materialised quiz results, graded
 * assignment submissions) and answers whether the course is complete,
 * what is missing, and the overall score. It never reads a client claim.
 *
 * The default rule is exactly the pre-Phase-3 behaviour: every lesson
 * completed and nothing else — because no quiz or assignment is marked
 * `required_for_completion` until an author says so.
 */

export interface CompletionRule {
  /** `all` = every published lesson; a number = at least that many. */
  readonly lessons: 'all' | 'none' | number;
  /** Quizzes marked `required_for_completion` must be passed. */
  readonly requiredQuizzes: boolean;
  /** Assignments marked `required_for_completion` must be graded. */
  readonly requiredAssignments: boolean;
  /** Minimum overall score (0–100) across the scored required items, or null. */
  readonly minOverallScore: number | null;
}

export const DEFAULT_COMPLETION_RULE: CompletionRule = {
  lessons: 'all',
  requiredQuizzes: true,
  requiredAssignments: true,
  minOverallScore: null,
};

export function parseCompletionRule(raw: unknown): CompletionRule {
  if (!raw || typeof raw !== 'object') return DEFAULT_COMPLETION_RULE;
  const value = raw as Record<string, unknown>;
  const lessons =
    value.lessons === 'none' || value.lessons === 'all'
      ? value.lessons
      : typeof value.lessons === 'number' &&
          Number.isInteger(value.lessons) &&
          value.lessons >= 0
        ? value.lessons
        : 'all';
  const minOverallScore =
    typeof value.minOverallScore === 'number' &&
    Number.isFinite(value.minOverallScore) &&
    value.minOverallScore >= 0 &&
    value.minOverallScore <= 100
      ? value.minOverallScore
      : null;
  return {
    lessons,
    requiredQuizzes: value.requiredQuizzes !== false,
    requiredAssignments: value.requiredAssignments !== false,
    minOverallScore,
  };
}

export interface LessonEvidence {
  readonly total: number;
  readonly completed: number;
}

export interface QuizEvidence {
  readonly quizId: string;
  readonly title: string;
  readonly required: boolean;
  readonly passed: boolean;
  readonly effectiveScore: number | null;
  readonly pendingGrading: boolean;
}

export interface AssignmentEvidence {
  readonly assignmentId: string;
  readonly title: string;
  readonly required: boolean;
  readonly submitted: boolean;
  readonly graded: boolean;
  readonly score: number | null;
}

export type MissingKind =
  | 'lessons'
  | 'quiz_not_passed'
  | 'quiz_pending_grading'
  | 'assignment_not_submitted'
  | 'assignment_not_graded'
  | 'min_overall_score';

export interface MissingItem {
  readonly kind: MissingKind;
  readonly id: string | null;
  readonly title: string | null;
  /** For lessons: how many remain; for min score: the shortfall. */
  readonly detail: number | null;
}

export interface CompletionEvaluation {
  readonly completed: boolean;
  readonly overallScore: number | null;
  readonly missing: readonly MissingItem[];
  readonly lessons: LessonEvidence;
  readonly requiredQuizzes: readonly QuizEvidence[];
  readonly requiredAssignments: readonly AssignmentEvidence[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function evaluateCompletion(
  rule: CompletionRule,
  lessons: LessonEvidence,
  quizzes: readonly QuizEvidence[],
  assignments: readonly AssignmentEvidence[],
): CompletionEvaluation {
  const missing: MissingItem[] = [];

  // Lessons.
  const lessonsNeeded =
    rule.lessons === 'all'
      ? lessons.total
      : rule.lessons === 'none'
        ? 0
        : Math.min(rule.lessons, lessons.total);
  if (lessons.completed < lessonsNeeded) {
    missing.push({
      kind: 'lessons',
      id: null,
      title: null,
      detail: lessonsNeeded - lessons.completed,
    });
  }

  // Required quizzes.
  const requiredQuizzes = rule.requiredQuizzes
    ? quizzes.filter((quiz) => quiz.required)
    : [];
  for (const quiz of requiredQuizzes) {
    if (quiz.passed) continue;
    missing.push({
      kind: quiz.pendingGrading ? 'quiz_pending_grading' : 'quiz_not_passed',
      id: quiz.quizId,
      title: quiz.title,
      detail: null,
    });
  }

  // Required assignments.
  const requiredAssignments = rule.requiredAssignments
    ? assignments.filter((assignment) => assignment.required)
    : [];
  for (const assignment of requiredAssignments) {
    if (assignment.graded) continue;
    missing.push({
      kind: assignment.submitted ? 'assignment_not_graded' : 'assignment_not_submitted',
      id: assignment.assignmentId,
      title: assignment.title,
      detail: null,
    });
  }

  // Overall score: the mean of the scored required items (quizzes'
  // effective scores, assignments' grades). Null when nothing is scored.
  const scored: number[] = [
    ...requiredQuizzes
      .map((quiz) => quiz.effectiveScore)
      .filter((s): s is number => s !== null),
    ...requiredAssignments.map((a) => a.score).filter((s): s is number => s !== null),
  ];
  const overallScore =
    scored.length > 0 ? round2(scored.reduce((a, b) => a + b, 0) / scored.length) : null;

  if (rule.minOverallScore !== null) {
    if (overallScore === null) {
      // A minimum score with nothing scored yet cannot be met.
      if (requiredQuizzes.length + requiredAssignments.length > 0) {
        missing.push({
          kind: 'min_overall_score',
          id: null,
          title: null,
          detail: rule.minOverallScore,
        });
      }
    } else if (overallScore < rule.minOverallScore) {
      missing.push({
        kind: 'min_overall_score',
        id: null,
        title: null,
        detail: round2(rule.minOverallScore - overallScore),
      });
    }
  }

  // A course with nothing in it is never "complete".
  const hasAnything =
    lessons.total > 0 || requiredQuizzes.length > 0 || requiredAssignments.length > 0;
  return {
    completed: hasAnything && missing.length === 0,
    overallScore,
    missing,
    lessons,
    requiredQuizzes,
    requiredAssignments,
  };
}
