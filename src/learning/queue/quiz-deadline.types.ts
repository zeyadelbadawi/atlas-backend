/**
 * P64 Phase 3 (AD-8) — the delayed auto-submit job. One job per timed
 * attempt, keyed by attempt id so a resume never schedules a second, fired
 * at `deadline + grace`. The maintenance sweep is the safety net for a
 * job Redis lost.
 */
export const QUIZ_DEADLINE_QUEUE = 'quiz-deadlines';
export const QUIZ_DEADLINE_FINALIZE_JOB = 'finalize';

export interface QuizDeadlineJobPayload {
  readonly attemptId: string;
  readonly studentId: string;
}

export function quizDeadlineJobId(attemptId: string): string {
  return `quiz-deadline:${attemptId}`;
}
