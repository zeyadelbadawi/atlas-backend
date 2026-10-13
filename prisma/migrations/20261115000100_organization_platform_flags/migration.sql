-- =============================================================================
-- B0-ANL-04 (part 1) — the Platform Owner can mark an organization as
-- internal (a test, demo or staff organization), so platform metrics such
-- as MRR (B0-ANL-01) can leave it out.
--
-- A SEPARATE, PLATFORM-ONLY TABLE rather than a column on `organizations`:
-- `organizations` has no Platform Owner UPDATE policy, and adding one would
-- let a Platform Owner session write every column of every organization.
-- This table carries only operator flags; tenants have no policy on it at
-- all, so a tenant, learner or context-less session reads and writes
-- nothing. One row per organization at most (the key IS the organization).
--
--   * SELECT / INSERT / UPDATE: `is_platform_owner(app.current_user_id)`.
--   * No DELETE policy: the flag is switched off, never removed; the row
--     goes away with its organization (ON DELETE CASCADE).
--
-- Additive and idempotent. Rollback: `DROP TABLE "organization_platform_flags";`
-- (metrics then include every organization again, as before).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "organization_platform_flags" (
    "organization_id" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_platform_flags_pkey" PRIMARY KEY ("organization_id")
);

DO $$ BEGIN
  ALTER TABLE "organization_platform_flags"
    ADD CONSTRAINT "organization_platform_flags_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "organization_platform_flags"
    ADD CONSTRAINT "organization_platform_flags_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "organization_platform_flags_is_internal_idx"
  ON "organization_platform_flags"("is_internal") WHERE "is_internal";

ALTER TABLE "organization_platform_flags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_platform_flags" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "organization_platform_flags_platform_select" ON "organization_platform_flags";
CREATE POLICY "organization_platform_flags_platform_select" ON "organization_platform_flags"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "organization_platform_flags_platform_insert" ON "organization_platform_flags";
CREATE POLICY "organization_platform_flags_platform_insert" ON "organization_platform_flags"
  FOR INSERT WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "organization_platform_flags_platform_update" ON "organization_platform_flags";
CREATE POLICY "organization_platform_flags_platform_update" ON "organization_platform_flags"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
