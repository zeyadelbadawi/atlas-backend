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

/**
 * One job per attempt, keyed by attempt id. NO colon: BullMQ refuses a
 * custom id containing `:` unless it has exactly three segments (its own
 * legacy repeat-key shape), throwing "Custom Id cannot contain :" from
 * `queue.add`. The original `quiz-deadline:<id>` hit that rule on every
 * attempt, the producer's best-effort catch logged it as a warning, and no
 * deadline job was ever scheduled — found by the 22 Sep 2026 production
 * validation, where timed attempts only finalised when their learner next
 * read them. `quizDeadlineJobId.spec.ts` pins the shape.
 */
export function quizDeadlineJobId(attemptId: string): string {
  return `quiz-deadline-${attemptId}`;
}
