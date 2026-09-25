/**
 * The `video-retention` BullMQ queue — P64 Communications C6.
 *
 * A SEPARATE QUEUE, and exactly ONE processor on it. Three job names
 * share that one processor, following `communications`' own precedent
 * ("five job names on one queue, one processor") rather than opening a
 * queue per job:
 *
 *   - `sweep`  — repeatable, every 15 minutes. Evaluates §31's windows for
 *     every candidate organisation, emits the warnings that are due and
 *     enqueues the deletion work for any tenant that has crossed its date
 *     with all four warnings behind it.
 *   - `asset`  — ONE per media asset. Deletes at the provider, verifies,
 *     then writes the tombstone. Five attempts.
 *   - `tenant` — one per tenant per deletion run. Waits for every `asset`
 *     job of that run to settle and then emits D, honestly, including
 *     when some of them failed.
 *
 * WHY ONE PROCESSOR IS LOAD-BEARING (read `communications.types.ts`'s own
 * header for the long version): BullMQ hands a job to whichever worker on
 * the queue takes it first, NOT to the one whose `process` understands the
 * name. A second processor class decorated for this queue would not handle "its
 * own" jobs — it would compete for all of them, and anything landing on
 * the worker that does not recognise the name is acknowledged and
 * dropped. On this queue that failure mode is worse than lost email: an
 * `asset` job silently eaten AFTER the provider delete would leave the
 * bytes gone and no tombstone written. `one-worker-per-queue.spec.ts`
 * enforces the rule structurally; add a job NAME here and a `case` to
 * `VideoRetentionProcessor`, never a second processor class.
 *
 * (The guard scans source TEXT, comments included, so this paragraph
 * deliberately does not spell the decorator call out. It errs toward a
 * false positive rather than toward missing a real second worker, which
 * is the right way round for a rule whose failure is silent.)
 *
 * Job ids never contain `:` — P64 Phase 3's finding that BullMQ treats a
 * colon in a custom id as a key separator. The dedupe keys inside the
 * database do contain colons; these ids deliberately do not.
 */
export const VIDEO_RETENTION_QUEUE = 'video-retention';

export const VIDEO_RETENTION_JOB_SWEEP = 'sweep';
export const VIDEO_RETENTION_JOB_ASSET = 'asset';
export const VIDEO_RETENTION_JOB_TENANT = 'tenant';

export const VIDEO_RETENTION_SWEEP_REPEAT_JOB_ID = 'video-retention-sweep-repeat';

/** The same cadence as the subscription sweep: §31's dates are days apart, not minutes. */
export const VIDEO_RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * §31 — "attempts 5 with backoff". Exponential from one minute
 * (1 m, 2 m, 4 m, 8 m), so a provider having a bad ten minutes is ridden
 * out rather than escalated, and a provider that is genuinely broken is
 * escalated within a quarter of an hour instead of retrying all day.
 */
export const VIDEO_RETENTION_ASSET_ATTEMPTS = 5;
export const VIDEO_RETENTION_ASSET_BACKOFF_MS = 60 * 1000;

/**
 * The tenant-level job's own budget. It does no provider work; it waits
 * for the asset jobs to settle and then speaks once. Ten attempts at a
 * two-minute exponential floor comfortably outlasts five asset attempts
 * plus their backoff, and if it still cannot see a settled set it gives up
 * WITHOUT sending D — silence is the honest outcome, because the whole
 * point of D is to state what happened.
 */
export const VIDEO_RETENTION_TENANT_ATTEMPTS = 10;
export const VIDEO_RETENTION_TENANT_BACKOFF_MS = 2 * 60 * 1000;
/** How long after the asset jobs the tenant job first looks. */
export const VIDEO_RETENTION_TENANT_DELAY_MS = 60 * 1000;

/**
 * The hard ceiling on organisations one sweep tick evaluates, and on
 * assets one tick will enqueue for deletion.
 *
 * The asset ceiling is the more important of the two and is deliberately
 * modest: it bounds how much can go wrong in one tick. Anything deferred
 * is picked up by the next tick with no loss, because the deletion step
 * stays due for its whole seven-day horizon.
 */
export const VIDEO_RETENTION_MAX_ORGS_PER_TICK = 2000;
export const VIDEO_RETENTION_MAX_ASSETS_PER_TICK = 500;

export interface VideoRetentionSweepJobPayload {
  readonly kind?: 'sweep';
}

export interface VideoRetentionAssetJobPayload {
  readonly assetId: string;
  readonly organizationId: string;
  /** ISO — the retention anchor this deletion was authorised against. Re-checked at execution. */
  readonly anchorAt: string;
  readonly reason: string;
}

export interface VideoRetentionTenantJobPayload {
  readonly organizationId: string;
  readonly anchorAt: string;
  /** The assets this run enqueued, so D reports on THIS run and not on history. */
  readonly assetIds: readonly string[];
}

export type VideoRetentionJobPayload =
  | VideoRetentionSweepJobPayload
  | VideoRetentionAssetJobPayload
  | VideoRetentionTenantJobPayload;

/** Deterministic and colon-free: one asset, one anchor, one job — a repeated tick re-derives the same id and BullMQ rejects the duplicate. */
export function retentionAssetJobId(assetId: string, anchorAt: Date): string {
  return `ret-asset-${assetId}-${anchorAt.getTime()}`;
}

export function retentionTenantJobId(organizationId: string, anchorAt: Date): string {
  return `ret-tenant-${organizationId}-${anchorAt.getTime()}`;
}
