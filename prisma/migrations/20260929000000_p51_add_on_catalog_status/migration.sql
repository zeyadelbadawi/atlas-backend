-- P51 — Platform-Owner-controlled add-on catalog publication state.
--
-- Adds a central, backend-authoritative catalog status to `add_ons`, DISTINCT
-- from `tenant_add_on_status` (a single Academy's installation lifecycle).
-- One value per add-on, for the whole customer store.
--
-- Creating a NEW enum type and using it in the same migration is safe — the
-- "unsafe use of new enum value" restriction only applies to ALTER TYPE ADD
-- VALUE on an existing type, not CREATE TYPE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'add_on_catalog_status') THEN
    CREATE TYPE "add_on_catalog_status" AS ENUM ('draft', 'coming_soon', 'published');
  END IF;
END$$;

-- New add-ons default to `draft` (not exposed to customers until a Platform
-- Owner publishes them). `version` follows the repo's optimistic-concurrency
-- convention for catalog-status changes.
ALTER TABLE "add_ons"
  ADD COLUMN IF NOT EXISTS "catalog_status" "add_on_catalog_status" NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- INITIAL STATE FOR EXISTING ADD-ONS, from evidence of current store behavior:
--   * Every add-on except Live Sessions is currently installable/purchasable
--     in the customer store today  -> published.
--   * Live Sessions is intentionally deferred pending external Zoom approvals
--     (previously enforced by the DEFERRED_ADD_ON_KEYS constant, now by this
--     authoritative column) -> coming_soon. It MUST NOT be auto-published.
UPDATE "add_ons" SET "catalog_status" = 'published' WHERE "key" <> 'live-sessions';
UPDATE "add_ons" SET "catalog_status" = 'coming_soon' WHERE "key" = 'live-sessions';
