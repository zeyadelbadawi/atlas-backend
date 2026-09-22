import type { QuizAttempt as PrismaQuizAttempt } from '@prisma/client';

export interface QuizAnswerResponse {
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly text?: string;
}

/**
 * The attempt as the learner (and, with `studentName`, a reviewer) sees
 * it. P64 Phase 3 adds the engine columns. `score`/`passed` are withheld
 * when the caller passes a disclosure that forbids them — the legacy
 * default (no disclosure argument) keeps today's "score at once"
 * behaviour for reviewers and for quizzes whose policy is `immediately`.
 */
export interface QuizAttemptResponse {
  readonly id: string;
  readonly quizId: string;
  readonly studentId: string;
  readonly status: PrismaQuizAttempt['status'];
  readonly answers: readonly QuizAnswerResponse[];
  readonly score?: number;
  readonly passed?: boolean;
  readonly submittedAt?: string;
  readonly attemptNumber: number;
  readonly canRetry: boolean;
  readonly startedAt: string | null;
  readonly deadlineAt: string | null;
  readonly revision: number;
  readonly lastSavedAt: string | null;
  readonly autoSubmitted: boolean;
  readonly autoSubmittedReason: string | null;
  readonly isLate: boolean;
  readonly violationCount: number;
  readonly integrityFlagged: boolean;
  readonly gradingStatus: PrismaQuizAttempt['gradingStatus'];
  readonly pointsEarned: number | null;
  readonly pointsTotal: number | null;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
}

export function toQuizAttemptResponse(
  attempt: PrismaQuizAttempt,
  canRetry: boolean,
  disclosure: { readonly score: boolean } = { score: true },
): QuizAttemptResponse {
  const showScore = disclosure.score;
  return {
    id: attempt.id,
    quizId: attempt.quizId,
    studentId: attempt.studentId,
    status: attempt.status,
    answers: (attempt.answers as unknown as readonly QuizAnswerResponse[]) ?? [],
    score: showScore && attempt.score !== null ? Number(attempt.score) : undefined,
    passed: showScore ? (attempt.passed ?? undefined) : undefined,
    submittedAt: attempt.submittedAt?.toISOString(),
    attemptNumber: attempt.attemptNumber,
    canRetry,
    startedAt: attempt.startedAt?.toISOString() ?? attempt.createdAt.toISOString(),
    deadlineAt: attempt.deadlineAt?.toISOString() ?? null,
    revision: attempt.answersRevision,
    lastSavedAt: attempt.lastSavedAt?.toISOString() ?? null,
    autoSubmitted: attempt.autoSubmitted,
    autoSubmittedReason: attempt.autoSubmittedReason,
    isLate: attempt.isLate,
    violationCount: attempt.violationCount,
    integrityFlagged: attempt.integrityFlagged,
    gradingStatus: attempt.gradingStatus,
    pointsEarned:
      showScore && attempt.pointsEarned !== null ? Number(attempt.pointsEarned) : null,
    pointsTotal: attempt.pointsTotal !== null ? Number(attempt.pointsTotal) : null,
    invalidatedAt: attempt.invalidatedAt?.toISOString() ?? null,
    invalidationReason: attempt.invalidationReason,
  };
}
