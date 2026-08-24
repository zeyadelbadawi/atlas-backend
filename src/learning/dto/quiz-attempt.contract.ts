/**
 * `QuizAttempt` response contract — matches `quiz.types.ts` field-for-field.
 * `canRetry` is computed (never stored) from the quiz's `maxAttempts` and
 * the student's real attempt count — see `QuizzesService`.
 */
import type { QuizAttempt as PrismaQuizAttempt } from '@prisma/client';

export interface QuizAnswerResponse {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
}

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
}

export function toQuizAttemptResponse(
  attempt: PrismaQuizAttempt,
  canRetry: boolean,
): QuizAttemptResponse {
  return {
    id: attempt.id,
    quizId: attempt.quizId,
    studentId: attempt.studentId,
    status: attempt.status,
    answers: (attempt.answers as unknown as readonly QuizAnswerResponse[]) ?? [],
    score: attempt.score !== null ? Number(attempt.score) : undefined,
    passed: attempt.passed ?? undefined,
    submittedAt: attempt.submittedAt?.toISOString(),
    attemptNumber: attempt.attemptNumber,
    canRetry,
  };
}
