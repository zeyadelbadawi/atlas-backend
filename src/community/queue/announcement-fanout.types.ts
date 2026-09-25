/**
 * Announcement fan-out queue (cloud remediation, finding F).
 *
 * Publishing an announcement used to emit one notification per learner
 * INSIDE the publish request's interactive transaction (5 s timeout): an
 * academy-wide announcement to a few thousand learners timed out and
 * rolled the publish back. The request now enqueues ONE job; this queue
 * expands the audience in bounded batches.
 *
 * One queue, ONE processor, one job name. Job ids are deterministic and
 * colon-free: `announcement-fanout-<announcementId>-<publishedAtMs>`.
 */
export const ANNOUNCEMENT_FANOUT_QUEUE = 'announcement-fanout';
export const ANNOUNCEMENT_FANOUT_JOB = 'fan-out';

/** Recipients emitted per transaction — well inside the 5 s interactive-transaction budget. */
export const ANNOUNCEMENT_FANOUT_BATCH_SIZE = 200;

export interface AnnouncementFanOutJobPayload {
  readonly announcementId: string;
  readonly academyId: string;
  readonly organizationId: string;
  readonly courseId: string | null;
  /** The publisher; the fan-out runs in their user context PLUS the tenant context, never wider than the publish itself. */
  readonly actorUserId: string;
  /** ISO-8601 — identifies THIS publish, so a job can tell "not committed yet" from "a different publish". */
  readonly publishedAt: string;
}
