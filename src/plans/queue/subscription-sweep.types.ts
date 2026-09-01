/** Matches `TenantUsageRecomputeProducer`'s queue-constant precedent exactly. */
export const SUBSCRIPTION_SWEEP_QUEUE = 'subscription-sweep';
export const SUBSCRIPTION_SWEEP_JOB = 'run';
/** Fixed BullMQ repeat-job id — registering the SAME id+interval on every app boot is idempotent (BullMQ dedups by repeat key), so this never accumulates duplicate recurring jobs across restarts/multiple instances. */
export const SUBSCRIPTION_SWEEP_REPEAT_JOB_ID = 'subscription-sweep-recurring';

/**
 * How often the sweep fires — Phase 2's one scheduling mechanism for BOTH
 * trial expiry and the usage-recompute safety net (roadmap: "Use one
 * mechanism for both ... not two separate ones"). 15 minutes is frequent
 * enough that a 3-day trial's expiry is never meaningfully late, and cheap
 * enough (an idempotent, per-organization full recompute) to run this
 * often at this codebase's current scale.
 */
export const SUBSCRIPTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export type SubscriptionSweepJobPayload = Record<string, never>;
