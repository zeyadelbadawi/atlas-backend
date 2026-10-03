/**
 * Whether a learner has started, is working through, or has completed a
 * course — the one rule behind every Start / Continue / Completed call to
 * action (Task E), computed from `CourseProgress` alone.
 *
 * WHY NOT `completionState` ON ITS OWN. It only becomes `in_progress` once
 * something is FINISHED (a lesson completed, a quiz scored, an assignment
 * submitted). A learner who watched half of the first video has started,
 * and "Start course" would be wrong for them. Playback heartbeats stamp
 * `lastActivityAt` (enrollment never does), so any recorded activity
 * counts as started.
 *
 * WHY NOT `Enrollment.status`/`completedAt`. Nothing in the learning flow
 * writes them; completion lives on `CourseProgress`.
 */
export type LearningState = 'not_started' | 'in_progress' | 'completed';

export interface LearningStateInput {
  readonly completionState: 'incomplete' | 'in_progress' | 'completed';
  readonly completedItems?: number | null;
  readonly completedLessons?: number | null;
  readonly lastActivityAt?: Date | null;
}

export function deriveLearningState(
  progress: LearningStateInput | null | undefined,
): LearningState {
  if (!progress) return 'not_started';
  if (progress.completionState === 'completed') return 'completed';
  if (
    progress.completionState === 'in_progress' ||
    (progress.completedItems ?? 0) > 0 ||
    (progress.completedLessons ?? 0) > 0 ||
    progress.lastActivityAt
  ) {
    return 'in_progress';
  }
  return 'not_started';
}
