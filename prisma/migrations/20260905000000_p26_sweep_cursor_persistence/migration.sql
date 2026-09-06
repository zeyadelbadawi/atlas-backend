-- ============================================================================
-- P26 — Phase 4.6 (scalability fix): persist SubscriptionSweepService's
-- stale-usage scan cursor ACROSS ticks.
--
-- `ATLAS_SCALE_VALIDATION_PHASE_4_6_REPORT.md` ("Failure 1") proved that
-- `SubscriptionSweepService.run()` kept its scan cursor in a local
-- variable, reset to `undefined` on every single invocation. At 100K+
-- organization scale this meant every tick re-scanned `organizations`
-- from the very beginning of the id space, so the portion of the stale
-- backlog past `SUBSCRIPTION_SWEEP_MAX_RECOMPUTE_PER_TICK` was never
-- reached by any tick, ever — the sweep degraded from "safety net" to
-- "processes the same first page forever" as the platform grew.
--
-- `tenant_usage_sweep_cursor` is a platform-owned singleton (mirrors
-- `trial_policy`'s own shape/precedent exactly — see that model's schema
-- doc comment): exactly one logical row, read/written via a fixed,
-- well-known id + `upsert` in `TenantUsageSweepCursorRepository`, which
-- closes the concurrent-first-read race atomically at the database level
-- rather than by application discipline. That race-safety is required
-- here specifically because more than one backend instance's sweep
-- worker may read/write this row concurrently under BullMQ horizontal
-- scaling.
--
-- No RLS: this row carries no tenant data (a platform-wide cursor, not
-- anything scoped to an organization), exactly like `trial_policy` has no
-- RLS policy either. No index beyond the primary key is needed — this
-- table only ever has one row, looked up by that same primary key.
-- ============================================================================

CREATE TABLE "tenant_usage_sweep_cursor" (
    "id" TEXT NOT NULL,
    "last_organization_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_usage_sweep_cursor_pkey" PRIMARY KEY ("id")
);
