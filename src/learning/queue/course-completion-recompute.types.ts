/**
 * Course-completion fan-out (B7 V15 follow-up).
 *
 * An AUTHORING change can change whether learners have finished a course
 * without any write of theirs: a required quiz detached from its unit, a
 * requirement lifted, a unit deleted. `recompute` used to catch that only
 * on each learner's next read or write, so the stored verdict (the
 * `completion_state` every list, report and dashboard reads) stayed stale
 * until then. The authoring write now enqueues ONE job for the course,
 * after its own transaction commits, and this queue recomputes every
 * active enrollment of that course in the academy's tenant context.
 *
 * One queue, ONE processor, one job name. One job per COURSE, keyed by
 * course id and released after a short delay, so a burst of edits (an
 * author detaching five quizzes in a row) collapses into one fan-out.
 */
export const COURSE_COMPLETION_RECOMPUTE_QUEUE = 'course-completion-recompute';
export const COURSE_COMPLETION_RECOMPUTE_JOB = 'recompute-course';

export interface CourseCompletionRecomputeJobPayload {
  readonly courseId: string;
  readonly academyId: string;
}

/**
 * How long a job waits before it runs: long enough to let the authoring
 * transaction commit and to coalesce a burst of edits on one course into a
 * single job, short enough that the stored verdict catches up while the
 * author is still on the page.
 */
export const COURSE_COMPLETION_RECOMPUTE_DELAY_MS = 5_000;

/** Enrollments read per tenant-context transaction while listing a course's learners. */
export const COURSE_COMPLETION_RECOMPUTE_BATCH_SIZE = 200;

/**
 * Two courses fan out at once. Each job walks its course's enrollments
 * SEQUENTIALLY — one short tenant-context transaction (one pooled
 * connection) per enrollment — so this is also the cap on pooled
 * connections the queue holds at any moment. The queue is driven by
 * authoring edits, not learner traffic, so it is low volume; 2 keeps two
 * academies' edits from waiting on each other while leaving the shared
 * Prisma pool (see `TENANT_USAGE_RECOMPUTE_CONCURRENCY` for the measured
 * pool size) to the API and the busier queues.
 */
export const COURSE_COMPLETION_RECOMPUTE_CONCURRENCY = 2;

/**
 * The one job id per course; `followup` is the second job queued while
 * the first is already running (it may have read the course before the
 * newest edit committed). NO colon: BullMQ refuses a custom id containing
 * ':' unless it has exactly three segments (see `quizDeadlineJobId`).
 */
export function courseCompletionRecomputeJobId(
  courseId: string,
  suffix?: 'followup',
): string {
  return suffix
    ? `course-completion-recompute-${courseId}-${suffix}`
    : `course-completion-recompute-${courseId}`;
}

/** The quiz/assignment fields learner-facing completion reads (`CourseCompletionService.evaluate`). */
export interface CompletionRelevantItem {
  readonly status: string;
  readonly sectionId: string | null;
  readonly requiredForCompletion: boolean;
}

/**
 * Whether the item is part of the learner's course at all: published AND
 * placed in a unit — exactly the filter `evaluate()` applies.
 */
export function countsTowardCompletion(
  item: Pick<CompletionRelevantItem, 'status' | 'sectionId'>,
): boolean {
  return item.status === 'published' && item.sectionId !== null;
}

/**
 * Whether an authoring change to one quiz/assignment can change any
 * learner's completion. `null` stands for "does not exist" (before a
 * create, after a delete). Moving a counted item from one unit to another
 * changes nothing; neither does touching an item no learner can see.
 */
export function isCompletionRelevantItemChange(
  before: CompletionRelevantItem | null,
  after: CompletionRelevantItem | null,
): boolean {
  const countedBefore = before !== null && countsTowardCompletion(before);
  const countedAfter = after !== null && countsTowardCompletion(after);
  if (countedBefore !== countedAfter) return true;
  if (!countedBefore) return false;
  return before!.requiredForCompletion !== after!.requiredForCompletion;
}
