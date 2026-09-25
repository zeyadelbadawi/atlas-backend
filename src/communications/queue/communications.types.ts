/**
 * The `communications` BullMQ queue — P64 Communications C1.
 *
 * SIX job names on ONE queue, and exactly ONE processor (the established
 * "one queue, one repeatable job, one processor" rule of
 * `SubscriptionSweepScheduler`, extended to a small family of related
 * jobs rather than five queues).
 *
 * "Exactly one" is load-bearing, not tidiness: BullMQ hands each job to
 * whichever WORKER on that queue takes it first, not to the one that
 * understands its name. A second `@Processor('communications')` therefore
 * does not "handle its own jobs" — it competes for ALL of them, and every
 * job that lands on the worker that does not know the name is dropped by
 * that worker's `default` branch. Two workers on this queue means roughly
 * half the outbox emails and half the delivery webhooks silently vanish.
 * Add a job NAME here and a `case` to `CommunicationsProcessor`; never a
 * second processor class.
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
 *   - `webhook`  — one job per inbound provider delivery event, enqueued
 *     by the webhook route so the HTTP handler answers 202 immediately.
 *   - `exception-activation` — every 5 min, tells a learner that a quiz
 *     exception scheduled for later has just opened. The only job here
 *     that EMITS rather than delivers; it is on this queue, under this
 *     processor, precisely because a second `@Processor` would eat the
 *     other five.
 *
 * Job ids never contain `:` (P64 Phase 3 finding — BullMQ treats a colon
 * in a custom id as a key separator).
 */
export const COMMUNICATIONS_QUEUE = 'communications';

export const COMMUNICATION_JOB_DISPATCH = 'dispatch';
export const COMMUNICATION_JOB_SWEEP = 'sweep';
export const COMMUNICATION_JOB_DIGEST = 'digest';
export const COMMUNICATION_JOB_PRUNE = 'prune';
/** Inbound provider delivery events (bounce/complaint/delivered). */
export const COMMUNICATION_JOB_WEBHOOK = 'webhook';
/** Scheduled learner exceptions whose `availableFrom` has now passed (W-EXC). */
export const COMMUNICATION_JOB_EXCEPTION_ACTIVATION = 'exception-activation';

export const COMMUNICATION_SWEEP_REPEAT_JOB_ID = 'communications-sweep-repeat';
export const COMMUNICATION_DIGEST_REPEAT_JOB_ID = 'communications-digest-repeat';
export const COMMUNICATION_PRUNE_REPEAT_JOB_ID = 'communications-prune-repeat';
export const COMMUNICATION_EXCEPTION_ACTIVATION_REPEAT_JOB_ID =
  'communications-exception-activation-repeat';

export const COMMUNICATION_SWEEP_INTERVAL_MS = 60 * 1000;
export const COMMUNICATION_DIGEST_INTERVAL_MS = 60 * 60 * 1000;
export const COMMUNICATION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * How often the exception-activation sweep asks "has a scheduled
 * exception opened?". Five minutes is the latency a learner sees between
 * their window opening and being told; it is not a correctness knob,
 * because the dedupe key is the transition instant and not the tick.
 */
export const COMMUNICATION_EXCEPTION_ACTIVATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far back the activation sweep looks.
 *
 * The sweep is stateless: it re-asks the question from the rows every
 * tick, so the window is what stops it re-reading years of history — NOT
 * what stops it re-notifying (the dedupe key does that, and would do it
 * with no window at all). Twenty-four hours means an outage of up to a
 * day still delivers every activation it missed; past that the news is
 * stale enough that telling someone their window opened yesterday is
 * worse than silence.
 */
export const COMMUNICATION_EXCEPTION_ACTIVATION_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Rows one activation tick will consider. */
export const COMMUNICATION_EXCEPTION_ACTIVATION_BATCH = 500;

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
