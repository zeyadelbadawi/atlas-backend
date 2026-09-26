-- New Customer Onboarding (26 Sep 2026) — docs/NEW_CUSTOMER_ONBOARDING.md §5.
--
-- The ONLY persistent onboarding state. Whether an Organization Owner has
-- finished (or deferred) the onboarding wizard cannot be derived from the
-- domain — it records a choice. Every step's completion is derived from the
-- real records instead (academies, website_configurations, courses, ...).
--
-- DEFAULT now() is deliberate: PostgreSQL gives every EXISTING row the
-- migration timestamp without a table rewrite, so no existing organization is
-- ever routed into onboarding, and the legacy creation paths
-- (`POST /organizations`, platform-created organizations) keep counting as
-- already onboarded. Only the new signup path inserts NULL explicitly.
--
-- No RLS change: organizations' existing policies already cover the owner's
-- own row. Rollback: the column is ignored by older code; dropping it is
-- optional.
ALTER TABLE "organizations" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- Stamping completion. `organizations` has NO UPDATE policy for `atlas_app`
-- (nothing in the product edits an organization row), and this change does
-- not add one: an owner UPDATE policy would let owner-context code rewrite
-- every column (name, slug, owner, status). Instead, one SECURITY DEFINER
-- function can change exactly one column, one way, for the owner only —
-- the same shape as `set_enrollment_completion`.
--
-- Checks, all against the CALLER's session settings (never parameters):
--   * `app.current_organization_id` must be the target organization;
--   * `app.current_user_id` must hold an `owner` membership in it.
-- Only a NULL value moves (to now()); it can never be cleared or moved back,
-- so the function is idempotent and cannot re-open onboarding.
-- Returns the number of rows changed (0 or 1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_organization_onboarding(p_organization_id text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user text := NULLIF(current_setting('app.current_user_id', true), '');
  v_ctx_org text := NULLIF(current_setting('app.current_organization_id', true), '');
  v_count integer := 0;
BEGIN
  IF v_user IS NULL OR v_ctx_org IS NULL OR v_ctx_org <> p_organization_id THEN
    RAISE EXCEPTION 'onboarding completion refused for %', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."organization_id" = p_organization_id
      AND m."user_id" = v_user
      AND m."role" = 'owner'
  ) THEN
    RAISE EXCEPTION 'onboarding completion refused for %', p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE "organizations"
     SET "onboarding_completed_at" = now()
   WHERE "id" = p_organization_id
     AND "onboarding_completed_at" IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE ALL ON FUNCTION complete_organization_onboarding(text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION complete_organization_onboarding(text) TO "atlas_app";
  END IF;
END $$;
