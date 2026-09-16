-- P57 — optimistic-concurrency token for Platform-Owner plan administration.
--
-- WHY. `plans` becomes writable by the SaaS Owner in this phase (trial
-- eligibility/duration, pricing, limits, features). Two owners editing the
-- same plan concurrently must not silently clobber each other, and this
-- repo already has exactly one answer for that: a numeric `version` in the
-- UPDATE's WHERE clause plus `StaleResourceVersionException` (409,
-- `stale_resource_version`). `website_pages` established it and `add_ons`
-- adopted it verbatim in P51 — this is the same column, not a new
-- mechanism.
--
-- Default 0 so every existing row starts at a known version; the first
-- edit moves it to 1. Backfill-free by construction.
ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
