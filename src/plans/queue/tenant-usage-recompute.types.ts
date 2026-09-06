/** Master plan §12/§21 Phase P4: "Workers: tenant-usage-recompute (scheduled)." See `TenantUsageRecomputeService`'s doc comment for this queue's per-organization scope boundary. */
export const TENANT_USAGE_RECOMPUTE_QUEUE = 'tenant-usage-recompute';

export const RECOMPUTE_ONE_JOB = 'recompute-one';

/**
 * Phase 4.5.2 (scalability) — BullMQ's own documented default worker
 * concurrency is 1 (unset, as this queue ran until this phase), meaning
 * every recompute job — whether from a reactive trigger or the sweep —
 * processed strictly one at a time; measured in Phase 4.5.1/4.5's own
 * investigation at ~50–90 jobs/sec on this database. Each job holds
 * exactly one pooled Postgres connection for its whole transaction
 * (`TenancyContextService.runInTenantContext`'s `SET LOCAL` + 7 parallel
 * queries + one upsert) — concurrency is a direct multiplier on
 * simultaneous pooled-connection usage, shared with ordinary API traffic
 * and the four other queues on the same `PrismaService` singleton/pool.
 *
 * Value chosen from this phase's own real benchmark, not guessed: on
 * this machine's Prisma default pool (CPU-derived, `4 physical cores * 2
 * + 1` = 9 connections, `.env` sets no explicit `connection_limit`),
 * 2,000 real jobs drained in 14.55s (~137/sec) at concurrency=4 with zero
 * errors; a second run at concurrency=8 drained the same batch in 10.2s
 * (~196/sec), also zero errors, but left only 1 of 9 pool connections
 * free for everything else the app does concurrently. 4 was chosen over
 * 8 specifically for that headroom margin, not because 8 failed — see
 * `ATLAS_SCALABILITY_PHASE_4_5_2_REPORT.md` §9 for both data points.
 * Production should set an explicit `connection_limit` (§12 of
 * `ATLAS_SCALABILITY_ARCHITECTURE_PLAN.md`) and re-benchmark against that
 * real number before raising this further — this value is correct for
 * this environment's pool, not a universal constant.
 */
export const TENANT_USAGE_RECOMPUTE_CONCURRENCY = 4;

export interface RecomputeOneJobPayload {
  readonly organizationId: string;
}
