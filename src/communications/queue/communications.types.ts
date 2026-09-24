/**
 * The `communications` BullMQ queue — P64 Communications C1.
 *
 * Four job names on ONE queue, one processor (the established "one queue,
 * one repeatable job, one processor" rule of `SubscriptionSweepScheduler`,
 * extended to a small family of related jobs rather than four queues):
 *
 *   - `dispatch` — one job per outbox row, enqueued after the emitting
 *     transaction commits. The row is the durable intent; this job is only
 *     a hint that it exists.
 *   - `sweep`    — every 60 s, re-enqueues anything left `pending`/`deferred`
 *     past `availableAt` (a lost hint, a cooldown that elapsed, a crashed
 *     worker). The reason a lost job never loses an email.
 *   - `digest`   — hourly, sends every digest window that has closed.
 *   - `prune`    — daily retention: outbox/deliveries/digests past 90 days,
 *     `notifications` past their retention class.
 *
 * Job ids never contain `:` (P64 Phase 3 finding — BullMQ treats a colon
 * in a custom id as a key separator).
 */
export const COMMUNICATIONS_QUEUE = 'communications';

export const COMMUNICATION_JOB_DISPATCH = 'dispatch';
export const COMMUNICATION_JOB_SWEEP = 'sweep';
export const COMMUNICATION_JOB_DIGEST = 'digest';
export const COMMUNICATION_JOB_PRUNE = 'prune';

export const COMMUNICATION_SWEEP_REPEAT_JOB_ID = 'communications-sweep-repeat';
export const COMMUNICATION_DIGEST_REPEAT_JOB_ID = 'communications-digest-repeat';
export const COMMUNICATION_PRUNE_REPEAT_JOB_ID = 'communications-prune-repeat';

export const COMMUNICATION_SWEEP_INTERVAL_MS = 60 * 1000;
export const COMMUNICATION_DIGEST_INTERVAL_MS = 60 * 60 * 1000;
export const COMMUNICATION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Delivery retry policy: 6 attempts, exponential from 30 s (30 s, 1 m, 2 m, 4 m, 8 m). */
export const COMMUNICATION_DISPATCH_ATTEMPTS = 6;
export const COMMUNICATION_DISPATCH_BACKOFF_MS = 30 * 1000;

/** How long a claimed row is held before the sweep may hand it out again. */
export const COMMUNICATION_CLAIM_LEASE_MS = 10 * 60 * 1000;

/** Retention: outbox, deliveries and digests (matches the `*_retention_delete` RLS policies). */
export const COMMUNICATION_RETENTION_DAYS = 90;

/** Per-recipient daily email caps outside the security/transactional categories. */
export const DAILY_EMAIL_CAP_LEARNER = 5;
export const DAILY_EMAIL_CAP_STAFF = 10;

/** Digest windows close at this local hour in the academy's timezone (UTC without one). */
export const DIGEST_LOCAL_HOUR = 8;

export interface CommunicationDispatchJobPayload {
  readonly outboxId: string;
}

export type CommunicationRepeatJobPayload = Record<string, never>;

/** Deterministic, colon-free id — the same claim cycle (`attempts`) can be enqueued once. */
export function dispatchJobId(outboxId: string, attempts: number): string {
  return `dispatch-${outboxId}-${attempts}`;
}
