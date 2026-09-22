/**
 * The unified curriculum SEQUENCE (master plan Phase 2 §D.3/§E.2).
 *
 * WHY THIS EXISTS AS ITS OWN ENDPOINT. Before it, the player had to
 * assemble "what comes next" itself from three separate lists — lessons
 * from the sections response, quizzes from one endpoint, assignments from
 * another — each with its own ordering and none of them knowing about the
 * others. Previous/Next therefore skipped assessments, and the sidebar
 * showed lessons in one place and quizzes in another, which is Finding
 * F3's "the player is not a player, it is three pages".
 *
 * One ordered list, computed server-side from the shared per-unit ordinal
 * (P52), fixes all of that at once: the sidebar, Previous/Next and
 * Continue are three views of THIS array, and they cannot disagree.
 *
 * NOTHING HERE IS CONTENT. The sequence carries titles, ordinals, states
 * and lock reasons — never a URL, never a body, never a signed anything.
 * A locked item is listed (the learner has to be able to see that it
 * exists and why it is locked) but carries nothing that could be fetched.
 */

export const SEQUENCE_ITEM_TYPES = [
  'lesson',
  'quiz',
  'assignment',
  'live_session',
] as const;
export type SequenceItemType = (typeof SEQUENCE_ITEM_TYPES)[number];

/**
 * Per-item state (Phase 2 §E.2's list, verbatim).
 *
 * Deliberately ONE vocabulary across all four types rather than each
 * type's own enum: the sidebar renders them side by side, and a learner
 * reading a column of statuses should not have to know that a quiz's
 * "passed" and a lesson's "completed" are different words for the same
 * shape of fact.
 */
export const SEQUENCE_ITEM_STATES = [
  'locked',
  'available',
  'in_progress',
  'completed',
  'passed',
  'failed',
  'submitted',
  'graded',
  'overdue',
] as const;
export type SequenceItemState = (typeof SEQUENCE_ITEM_STATES)[number];

/** Why an item is locked. Closed vocabulary — the frontend renders a real sentence per reason, so free text would be untranslatable. */
export const SEQUENCE_LOCK_REASONS = [
  /** Sequential unlock: an earlier item is not finished yet. */
  'previousIncomplete',
  /** Drip: `available_at` is in the future. */
  'scheduled',
  /** The live session has not started (and is not joinable yet). */
  'notStarted',
  /** Access to the course has ended (revoked, refunded, expired). */
  'accessEnded',
  /** P64 Phase 3: an earlier quiz marked "required to progress" has not been passed yet. */
  'quizNotPassed',
] as const;
export type SequenceLockReason = (typeof SEQUENCE_LOCK_REASONS)[number];

export interface CourseSequenceItem {
  readonly id: string;
  readonly type: SequenceItemType;
  readonly title: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  /** 1-based unit number, for the "2.3" label. Locale digits are the frontend's job. */
  readonly unitNumber: number;
  /** 1-based position within the unit. */
  readonly itemNumber: number;
  /** Position in the whole flattened sequence, so Previous/Next is an index step. */
  readonly position: number;
  readonly state: SequenceItemState;
  readonly lockReason: SequenceLockReason | null;
  readonly durationSeconds: number | null;
  readonly isPreview: boolean;
  /** Assignments and live sessions. Null for everything else. */
  readonly dueAt: string | null;
  readonly availableAt: string | null;
}

export interface CourseSequenceResponse {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly items: readonly CourseSequenceItem[];
  /** Where "Continue" goes: the first item that is not finished. Null when everything is done. */
  readonly continueItemId: string | null;
  readonly completedCount: number;
  readonly totalCount: number;
}
