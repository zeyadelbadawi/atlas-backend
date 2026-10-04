/**
 * W3 — the daily security-maintenance sweep: retention for the
 * authentication-security tables. One queue, one repeatable job, one
 * processor — the `Phase2MaintenanceScheduler` / `SubscriptionSweepScheduler`
 * rule (BullMQ's own `repeat`, no `@nestjs/schedule`).
 *
 * Job ids never contain `:` (BullMQ treats a colon as a key separator).
 */
export const SECURITY_MAINTENANCE_QUEUE = 'security-maintenance';
export const SECURITY_MAINTENANCE_JOB = 'sweep';
export const SECURITY_MAINTENANCE_REPEAT_JOB_ID = 'security-maintenance-repeat';

/** Daily: retention is not time-sensitive, and each run is a few bounded DELETEs. */
export const SECURITY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * `security_events` retention. The `security_events_retention_delete` RLS
 * policy encodes the same 90 days independently, so a wrong cutoff here can
 * never widen the delete.
 */
export const SECURITY_EVENTS_RETENTION_DAYS = 90;

export type SecurityMaintenanceJobPayload = Record<string, never>;
