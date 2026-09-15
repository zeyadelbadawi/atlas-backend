/**
 * The unified curriculum item (P52) — one ordered sequence per Unit
 * composed from the existing content entities. This is a *projection*, not
 * a new stored entity: a lesson stays a `CourseLesson`, a quiz a `Quiz`,
 * etc. The projection only tags each with its `type` and the shared unit
 * ordinal so the builder and the student page can render one mixed,
 * ordered list.
 */
export type CurriculumItemType = 'lesson' | 'quiz' | 'assignment' | 'live_session';

export interface CurriculumItemResponse {
  readonly id: string;
  readonly type: CurriculumItemType;
  readonly title: string;
  /** Shared unit ordinal (0-based, contiguous after a reorder). */
  readonly order: number;
  /** Per-type lifecycle state (`draft`/`published`/...), passed through as-is. */
  readonly status: string;
  readonly sectionId: string;
}

/** A course-level quiz/assignment that can be attached to a unit. */
export interface AvailableCurriculumItemResponse {
  readonly id: string;
  readonly type: 'quiz' | 'assignment';
  readonly title: string;
  readonly status: string;
  /** Which unit it currently sits in, or null when unattached (course-level). */
  readonly sectionId: string | null;
}
