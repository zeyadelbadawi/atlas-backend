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

/**
 * Phase 4.5.2 (scalability) — replaces the sweep's old "every organization,
 * every tick" guarantee with "every organization recomputed within this
 * many milliseconds of actually going stale." Deliberately longer than
 * `SUBSCRIPTION_SWEEP_INTERVAL_MS` (4x it): the reactive triggers wired
 * into the academy/course/enrollment/media write paths (Phase 2) already
 * keep an ACTIVE organization's usage current within moments of a real
 * change — this sweep exists only as the safety net for the rare case a
 * reactive trigger is missed. An organization with no real activity in the
 * last hour has, by definition, nothing for a recompute to find changed;
 * checking it every 15 minutes anyway would be pure wasted work at
 * platform scale. One hour is a deliberate, documented choice, not a
 * platform SLA — see `ATLAS_SCALABILITY_PHASE_4_5_2_REPORT.md` for the
 * reasoning and what would need to change if a tighter bound is ever
 * required by product.
 */
export const USAGE_STALENESS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Phase 4.5.2 — the hard ceiling on how many `tenant-usage-recompute`
 * jobs ONE sweep tick will ever enqueue, regardless of how many
 * organizations are simultaneously stale (e.g. immediately after this
 * mechanism is first deployed against an existing large platform, or
 * after extended downtime). This is what actually bounds worst-case
 * per-tick queue growth — the staleness window above only decides WHICH
 * organizations are candidates, not how many of them get enqueued at
 * once. When more organizations are stale than this ceiling allows in
 * one tick, the remainder simply waits for the next tick (cursor-
 * paginated, so no organization is skipped or double-counted across
 * ticks) — trading "all caught up in one tick" for "always caught up
 * within a bounded, predictable number of ticks," which is the entire
 * point of Phase 4.5.2 (ATLAS_SCALABILITY_ARCHITECTURE_PLAN.md Change 1).
 * Value chosen from this phase's own real, measured worker throughput,
 * not guessed: at `TENANT_USAGE_RECOMPUTE_CONCURRENCY = 4`, 2,000 real
 * jobs drained in 14.55s (~137/sec) against the real dev database with
 * zero errors — see `ATLAS_SCALABILITY_PHASE_4_5_2_REPORT.md` §9 for the
 * full benchmark. At that measured rate, this ceiling drains in roughly
 * 73 seconds — under 10% of the 900-second interval — leaving wide
 * margin for real-world contention with ordinary API traffic on the same
 * connection pool, while still large enough that a cold-start backlog
 * (e.g. this mechanism's first deployment against an existing 100K-
 * organization platform) fully catches up within roughly 10 ticks
 * (~2.5 hours) rather than needing days. Re-benchmark before raising
 * this further against a production connection pool sized explicitly
 * (§12 of ATLAS_SCALABILITY_ARCHITECTURE_PLAN.md) rather than this dev
 * machine's CPU-derived default.
 */
export const SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK = 10000;

/** Phase 4.5.2 — DB query page size for the cursor-paginated staleness scan inside one tick; an implementation-detail batch size, independent of the per-tick enqueue ceiling above. */
export const SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE = 500;

export type SubscriptionSweepJobPayload = Record<string, never>;
