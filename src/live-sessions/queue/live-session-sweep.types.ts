/** Mirrors `subscription-sweep.types` exactly — the established convention for a recurring job in this codebase. */
export const LIVE_SESSION_SWEEP_QUEUE = 'live-session-sweep';
export const LIVE_SESSION_SWEEP_JOB = 'run';
/** Fixed repeat-job id: BullMQ dedupes by repeat key, so registering the same id+interval on every boot (and on every instance) never accumulates duplicate recurring jobs. */
export const LIVE_SESSION_SWEEP_REPEAT_JOB_ID = 'live-session-sweep-recurring';

/**
 * How often the sweep fires.
 *
 * Five minutes rather than the subscription sweep's fifteen, because this
 * one has a genuine deadline: a starting-soon reminder is worthless if it
 * arrives after the class began. The reminder window below is comfortably
 * wider than this interval, so a session cannot slip between two ticks.
 */
export const LIVE_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How far ahead a starting-soon reminder is sent.
 *
 * Fifteen minutes is long enough to actually get to a computer and short
 * enough that the reminder is about NOW rather than about the diary. It
 * deliberately matches `JOIN_WINDOW_BEFORE_START_MS`: the moment a student
 * is told the class is starting is the moment they can genuinely act on
 * it, rather than being told to join a room that refuses them.
 */
export const STARTING_SOON_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long AFTER a scheduled start a reminder is still worth sending.
 *
 * Without a floor, a sweep resuming after an outage would announce
 * "starting soon" for every class that happened last week. A session more
 * than this far past its start is left alone — the reminder has missed its
 * purpose and sending it would be noise.
 */
export const STARTING_SOON_GRACE_MS = 5 * 60 * 1000;

/**
 * How long after a session ends before its provider report is requested.
 *
 * Zoom does not publish a participant report the instant a meeting ends;
 * asking immediately reliably returns nothing and burns one of the bounded
 * attempts below. Waiting is not a delay in the product — the live webhook
 * intervals are already showing by then, and this pass only corrects them.
 */
export const RECONCILIATION_DELAY_MS = 10 * 60 * 1000;

/**
 * How many times a session's report is requested before giving up.
 *
 * A meeting that nobody joined never gets a report, and retrying it every
 * five minutes forever would be a permanent, growing cost for a session
 * that has nothing to reconcile. After this many attempts the webhook
 * intervals stand as the record — which is the correct outcome, not a
 * failure: they are real attendance evidence, merely not the authoritative
 * tier.
 */
export const MAX_RECONCILIATION_ATTEMPTS = 5;

/** Ceiling on sessions handled per tick, bounding worst-case work the way `SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK` does. */
export const LIVE_SESSION_SWEEP_MAX_PER_TICK = 200;

export type LiveSessionSweepJobPayload = Record<string, never>;
