/**
 * The P64 Phase 2 maintenance sweep (master plan §F retention, §D.4
 * status-poll fallback).
 *
 * One repeatable BullMQ job carrying both, following
 * `SubscriptionSweepScheduler`'s established rule verbatim: this codebase
 * uses BullMQ's own `repeat` option and deliberately does NOT add
 * `@nestjs/schedule` alongside it — "one queue, one repeatable job, one
 * processor ... never two independent schedulers."
 *
 * Both jobs existed in Phase 2 with no caller at all, which is a quiet
 * and specific kind of bug: the code is written, the tests pass, and the
 * behaviour never happens. A retention rule nobody runs is not a
 * retention rule, and a status-poll fallback nobody schedules cannot
 * recover the webhook it exists to recover from.
 */
export const PHASE2_MAINTENANCE_QUEUE = 'p64-phase2-maintenance';
export const PHASE2_MAINTENANCE_JOB = 'sweep';
export const PHASE2_MAINTENANCE_REPEAT_JOB_ID = 'p64-phase2-maintenance-repeat';

/**
 * Ten minutes.
 *
 * Paced by the status poll, which is the time-sensitive half: §U alerts
 * when a video has been pending for more than 30 minutes, so a ten-minute
 * cadence gives three chances to recover a lost webhook before anyone is
 * paged. Retention is daily work and simply no-ops on the other runs.
 */
export const PHASE2_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

/** `content_access_log` retention window (§F). */
export const CONTENT_ACCESS_LOG_RETENTION_DAYS = 90;

export type Phase2MaintenanceJobPayload = Record<string, never>;
