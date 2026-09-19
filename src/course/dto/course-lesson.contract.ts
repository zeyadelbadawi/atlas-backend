/** `CourseLesson` response contract — matches `course.types.ts` field-for-field. */
import type { CourseLesson as PrismaCourseLesson } from '@prisma/client';
import type {
  SequenceItemState,
  SequenceLockReason,
} from '../../learning/dto/course-sequence.contract';

export interface CourseLessonResponse {
  readonly id: string;
  readonly courseId: string;
  readonly sectionId: string;
  readonly title: string;
  readonly description?: string;
  readonly order: number;
  readonly contentType: PrismaCourseLesson['contentType'];
  /**
   * DEPRECATED by P64 Phase 2 (finding S3).
   *
   * A durable, permanently valid address for the lesson's payload, handed
   * out in bulk for every lesson in the course at once. It outlived
   * refunds, revocations and the enrollment itself, and it worked for
   * anyone it was forwarded to.
   *
   * It is still emitted while the `content.protected` flag is off for the
   * academy, because the previous frontend image reads this field and
   * Phase 2 §T requires that image to keep working against the new schema.
   * Once the flag is global the field stops being emitted, and a later
   * phase drops the column. NOTHING NEW SHOULD READ IT — the replacement
   * is `GET /learning/courses/:id/lessons/:lessonId/content`, which
   * re-decides entitlement at the moment the bytes are asked for.
   */
  readonly contentUrl?: string;
  readonly status: PrismaCourseLesson['status'];
  /** P64 Phase 2 — a sample lesson, readable without an enrollment. */
  readonly isPreview?: boolean;
  /** P64 Phase 2 — for the curriculum's duration labels and the watched-ratio denominator. */
  readonly durationSeconds?: number | null;
  /** P64 Phase 2 — drip date, so the curriculum can say WHEN rather than just "locked". */
  readonly availableAt?: string | null;
  /** P64 Phase 2 — per-learner state, present only on the student-facing projection. */
  readonly lockState?: SequenceItemState;
  readonly lockReason?: SequenceLockReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** P64 Phase 2 — what the student-facing projection layers on top of the lesson row. */
export interface LessonProjectionOptions {
  /**
   * When false, `contentUrl` is omitted entirely — the S3 fix. Driven by
   * the `content.protected` per-academy flag, never by the caller.
   */
  readonly includeContentUrl: boolean;
  readonly lockState?: SequenceItemState;
  readonly lockReason?: SequenceLockReason | null;
}

export function toCourseLessonResponse(
  lesson: PrismaCourseLesson,
  options?: LessonProjectionOptions,
): CourseLessonResponse {
  // Defaults to INCLUDING the url, so every pre-existing caller (the
  // authoring screens, the instructor curriculum) is untouched by this
  // change. Only the student-facing projection passes options.
  const includeContentUrl = options?.includeContentUrl ?? true;
  return {
    id: lesson.id,
    courseId: lesson.courseId,
    sectionId: lesson.sectionId,
    title: lesson.title,
    description: lesson.description ?? undefined,
    order: lesson.order,
    contentType: lesson.contentType,
    ...(includeContentUrl ? { contentUrl: lesson.contentUrl ?? undefined } : {}),
    status: lesson.status,
    isPreview: lesson.isPreview,
    durationSeconds: lesson.durationSeconds,
    availableAt: lesson.availableAt?.toISOString() ?? null,
    ...(options?.lockState ? { lockState: options.lockState } : {}),
    ...(options && 'lockReason' in options ? { lockReason: options.lockReason ?? null } : {}),
    createdAt: lesson.createdAt.toISOString(),
    updatedAt: lesson.updatedAt.toISOString(),
  };
}
