-- W8A — PRODUCT DEFAULT, kept separate on purpose: seed gifted setup days on
-- the existing PAID plans (monthly 7 days, yearly 14 days).
--
-- This is a commercial decision the product owner may override. It lives in
-- its own migration so that changing or reverting it never touches the
-- schema change (20261104000600). After deploy, the values are ordinary
-- catalog data edited in the Platform plan admin (5..15, or blank for none).
--
-- WHICH PLANS. Active plans whose catalog price is greater than zero
-- (`pricing.amount > 0` or `pricing.yearlyAmount > 0`). Free and archived
-- plans are left without a gift. Only rows still at NULL are touched, so a
-- re-run, or a value a Platform Owner already chose, is never overwritten.
-- `version` is bumped on every touched row so an editor holding the old
-- version gets the normal 409 instead of silently overwriting the seed.
--
-- BACKUP. The touched ids and their previous values/versions are copied to
-- `atlas_migration_backups.w8_plans_gifted_days_seed` FIRST (a schema
-- outside Prisma's `public`, so it never shows as schema drift and is never
-- readable by the application role).
--
-- RECOVERY / REVERT (restores exactly the pre-seed state of the touched rows):
--   UPDATE "plans" p
--      SET "gifted_days_monthly" = b."gifted_days_monthly",
--          "gifted_days_yearly"  = b."gifted_days_yearly",
--          "version" = p."version" + 1
--     FROM atlas_migration_backups.w8_plans_gifted_days_seed b
--    WHERE b."id" = p."id";
-- Changing the defaults instead: edit the plans in the Platform plan admin.

CREATE SCHEMA IF NOT EXISTS atlas_migration_backups;
REVOKE ALL ON SCHEMA atlas_migration_backups FROM PUBLIC;

CREATE TABLE IF NOT EXISTS atlas_migration_backups.w8_plans_gifted_days_seed (
    "id" TEXT PRIMARY KEY,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "gifted_days_monthly" INTEGER,
    "gifted_days_yearly" INTEGER,
    "backed_up_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO atlas_migration_backups.w8_plans_gifted_days_seed
    ("id", "key", "version", "gifted_days_monthly", "gifted_days_yearly")
SELECT p."id", p."key", p."version", p."gifted_days_monthly", p."gifted_days_yearly"
  FROM "plans" p
 WHERE p."status" = 'active'
   AND p."gifted_days_monthly" IS NULL
   AND p."gifted_days_yearly" IS NULL
   AND (
     (CASE WHEN jsonb_typeof(p."pricing" -> 'amount') = 'number'
           THEN (p."pricing" ->> 'amount')::numeric ELSE 0 END) > 0
     OR (CASE WHEN jsonb_typeof(p."pricing" -> 'yearlyAmount') = 'number'
              THEN (p."pricing" ->> 'yearlyAmount')::numeric ELSE 0 END) > 0
   )
ON CONFLICT ("id") DO NOTHING;

UPDATE "plans" p
   SET "gifted_days_monthly" = 7,
       "gifted_days_yearly" = 14,
       "version" = p."version" + 1
  FROM atlas_migration_backups.w8_plans_gifted_days_seed b
 WHERE b."id" = p."id"
   AND p."gifted_days_monthly" IS NULL
   AND p."gifted_days_yearly" IS NULL;
