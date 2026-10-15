-- B0-CAT-03 — THE OWNER-APPROVED PLAN LADDER (owner decision, 15 Oct 2026).
--
-- The three self-serve plans keep their keys (the `?plan=<key>` contract,
-- the checkout snapshots and every subscription row stay valid) and become:
--
--   key          name (en / ar)               EGP / month   EGP / year
--   starter      Teacher / المعلّم               1,190        11,900
--   growth       Academy / الأكاديمية            2,790        27,900
--   enterprise   Organization / المؤسسة         7,490        74,900
--
-- with the ladder's capacity limits, all three trial-eligible, the yearly
-- gift at 14 days and no monthly gift. The USD Enterprise price is retired:
-- the `enterprise` row is the Organization plan from here on. The platform
-- trial goes from 3 to 14 days (the policy row and its column default); no
-- plan carries its own `trial_duration_days`, so the policy decides.
--
-- Source: the planning package's pricing proposal §4.2.1 / §4.2.3 /
-- §4.2.11. Not applied: per-academy email caps (no plan limit key exists)
-- and the Enterprise "from 15,000" tier (a sales conversation, not a row).
--
-- NOT TOUCHED: the Premium rows, add-ons, subscriptions, checkouts and
-- payments. A subscription keeps the limits it was granted until its next
-- renewal, and a renewal is priced from the live catalog.
--
-- Only rows that exist are updated, so on a fresh database (no plans yet)
-- this is a no-op and `prisma/seed.ts` creates the same values.
--
-- BACKUP. The three rows' previous values and the policy row are copied to
-- `atlas_migration_backups` FIRST (outside Prisma's `public`, never read by
-- the application role). `version` is bumped on every touched plan, so a
-- console editor holding the old version gets the normal 409.
--
-- REVERT (restores exactly the pre-migration state of the touched rows):
--   UPDATE "plans" p
--      SET "name" = b."name", "description" = b."description",
--          "name_localized" = b."name_localized",
--          "description_localized" = b."description_localized",
--          "limits" = b."limits", "pricing" = b."pricing",
--          "trial_eligible" = b."trial_eligible",
--          "trial_duration_days" = b."trial_duration_days",
--          "gifted_days_monthly" = b."gifted_days_monthly",
--          "gifted_days_yearly" = b."gifted_days_yearly",
--          "version" = p."version" + 1, "updated_at" = CURRENT_TIMESTAMP
--     FROM atlas_migration_backups.catalog_ladder_plans b
--    WHERE b."id" = p."id";
--   UPDATE "trial_policy" t SET "duration_days" = b."duration_days",
--          "updated_at" = CURRENT_TIMESTAMP
--     FROM atlas_migration_backups.catalog_ladder_trial_policy b
--    WHERE b."id" = t."id";
--   ALTER TABLE "trial_policy" ALTER COLUMN "duration_days" SET DEFAULT 3;

CREATE SCHEMA IF NOT EXISTS atlas_migration_backups;
REVOKE ALL ON SCHEMA atlas_migration_backups FROM PUBLIC;

CREATE TABLE IF NOT EXISTS atlas_migration_backups.catalog_ladder_plans (
    "id" TEXT PRIMARY KEY,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "name_localized" JSONB,
    "description_localized" JSONB,
    "limits" JSONB NOT NULL,
    "pricing" JSONB,
    "trial_eligible" BOOLEAN NOT NULL,
    "trial_duration_days" INTEGER,
    "gifted_days_monthly" INTEGER,
    "gifted_days_yearly" INTEGER,
    "backed_up_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO atlas_migration_backups.catalog_ladder_plans
    ("id", "key", "version", "name", "description", "name_localized",
     "description_localized", "limits", "pricing", "trial_eligible",
     "trial_duration_days", "gifted_days_monthly", "gifted_days_yearly")
SELECT "id", "key", "version", "name", "description", "name_localized",
       "description_localized", "limits", "pricing", "trial_eligible",
       "trial_duration_days", "gifted_days_monthly", "gifted_days_yearly"
  FROM "plans"
 WHERE "key" IN ('starter', 'growth', 'enterprise')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS atlas_migration_backups.catalog_ladder_trial_policy (
    "id" TEXT PRIMARY KEY,
    "duration_days" INTEGER NOT NULL,
    "backed_up_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO atlas_migration_backups.catalog_ladder_trial_policy ("id", "duration_days")
SELECT "id", "duration_days" FROM "trial_policy"
ON CONFLICT ("id") DO NOTHING;

UPDATE "plans" SET
    "name" = 'Teacher',
    "description" = 'For a teacher starting to sell courses online.',
    "name_localized" = jsonb_build_object('en', 'Teacher', 'ar', 'المعلّم'),
    "description_localized" = jsonb_build_object(
        'en', 'For a teacher starting to sell courses online.',
        'ar', 'للمعلّم الذي يبدأ بيع كورساته أونلاين.'),
    "limits" = '{"academies": 1, "students": 100, "instructors": 3, "staff": 3, "courses": 20, "generalStorage": 10, "videoStorage": 30, "videoStorageMinutes": 1200, "recordedSessions": 3}'::jsonb,
    "pricing" = '{"amount": 1190, "currency": "EGP", "billingCycle": "monthly", "yearlyAmount": 11900}'::jsonb,
    "trial_eligible" = true,
    "trial_duration_days" = NULL,
    "gifted_days_monthly" = NULL,
    "gifted_days_yearly" = 14,
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'starter';

UPDATE "plans" SET
    "name" = 'Academy',
    "description" = 'For an established teacher with assistants, or a small team under one brand.',
    "name_localized" = jsonb_build_object('en', 'Academy', 'ar', 'الأكاديمية'),
    "description_localized" = jsonb_build_object(
        'en', 'For an established teacher with assistants, or a small team under one brand.',
        'ar', 'للمعلّم الذي يعمل مع فريق مساعد، أو لفريق صغير تحت علامة واحدة.'),
    "limits" = '{"academies": 1, "students": 400, "instructors": 8, "staff": 8, "courses": "unlimited", "generalStorage": 30, "videoStorage": 75, "videoStorageMinutes": 3000, "recordedSessions": 10}'::jsonb,
    "pricing" = '{"amount": 2790, "currency": "EGP", "billingCycle": "monthly", "yearlyAmount": 27900}'::jsonb,
    "trial_eligible" = true,
    "trial_duration_days" = NULL,
    "gifted_days_monthly" = NULL,
    "gifted_days_yearly" = 14,
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'growth';

UPDATE "plans" SET
    "name" = 'Organization',
    "description" = 'For organizations running several academies.',
    "name_localized" = jsonb_build_object('en', 'Organization', 'ar', 'المؤسسة'),
    "description_localized" = jsonb_build_object(
        'en', 'For organizations running several academies.',
        'ar', 'للمؤسسات التي تدير عدة أكاديميات.'),
    "limits" = '{"academies": 5, "students": 1500, "instructors": 25, "staff": 25, "courses": "unlimited", "generalStorage": 100, "videoStorage": 200, "videoStorageMinutes": 8000, "recordedSessions": 30}'::jsonb,
    "pricing" = '{"amount": 7490, "currency": "EGP", "billingCycle": "monthly", "yearlyAmount": 74900}'::jsonb,
    "trial_eligible" = true,
    "trial_duration_days" = NULL,
    "gifted_days_monthly" = NULL,
    "gifted_days_yearly" = 14,
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'enterprise';

ALTER TABLE "trial_policy" ALTER COLUMN "duration_days" SET DEFAULT 14;
UPDATE "trial_policy" SET "duration_days" = 14, "updated_at" = CURRENT_TIMESTAMP;
