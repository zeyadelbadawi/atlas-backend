-- ============================================================================
-- P64 Phase 2 — the PREMIUM plan family (master plan D5, D10; DL-17, DL-18,
-- DL-24).
--
-- WHY A MIGRATION AND NOT ONLY THE SEED
--
-- `plans` is a PLATFORM-OWNED catalog table with no write endpoint. The
-- production deploy runs `prisma migrate deploy` and nothing else, so a
-- row that exists only in `prisma/seed.ts` never reaches a customer —
-- which is exactly what happened to the Live Sessions add-on before
-- `20260923010000_p45b_live_sessions_addon_catalog` was written. `20261009000100`
-- gave `plans` the `family`/`tier` columns; without this migration the
-- Premium family would be a column value no row has ever held.
--
-- WHY A SEPARATE MIGRATION FROM `20261009000100`
--
-- That migration is already applied to developer databases and to CI.
-- Editing an applied migration turns a checksum mismatch into a broken
-- environment for everyone else, which is the same reason Phase 2 split
-- the columns out of `20261009000000` in the first place.
--
-- WHAT THIS INSERTS — AND WHAT IT DELIBERATELY DOES NOT
--
-- KEY STYLE: hyphens, not underscores. `update-plan.dto.ts` validates a
-- plan key against /^[a-z0-9]+(?:-[a-z0-9]+)*$/, and every real key in
-- the catalog already uses hyphens (`advanced-analytics`,
-- `live-sessions`, `extra-academy`). Underscore keys would have been
-- inserted fine by this migration and then rejected by the Platform
-- Owner's own edit endpoint — a row nobody could maintain through the UI.
--
-- Three rows: `premium-starter`, `premium-growth`, `premium-enterprise`,
-- one per tier. Their limits and features are IDENTICAL to their Normal
-- counterparts (`starter`, `growth`, `enterprise`). D10 gives the FAMILY
-- authority over the video security capability class and the TIER
-- authority over commercial limits and features, so a Premium plan that
-- also changed the seat count would be two product changes wearing one
-- name — and an academy downgrading to Normal would lose instructors it
-- never bought video protection for.
--
-- `video_storage_minutes` is the tier's D5 baseline in BOTH families:
-- 500 / 2,000 / 5,000. D5 as amended explicitly PERMITS per-variant
-- values (`NORMAL_BASIC` ≠ `PREMIUM_BASIC`) and DL-24 records that as an
-- OPEN owner decision — the mechanism is one value per variant, which
-- already exists, so honouring a ruling later is a data change. Inventing
-- a different number here would be taking the decision instead.
--
-- PRICING IS BUSINESS DATA, NOT LOGIC. The amounts below are display-only
-- catalog metadata, exactly like the three Normal plans' — nothing in
-- checkout or authorization reads them. They are placeholders positioned
-- above their Normal counterpart; the Platform Owner sets the real prices
-- in the catalog. They are never derived from, or reconciled against, a
-- video provider's charges: D5 and D10 both forbid a provider price
-- appearing anywhere in Atlas.
--
-- THE KEYS ARE NOT `PREMIUM_BASIC`-SHAPED, on purpose. `plans.key` is the
-- identity `tenant_subscriptions` references; D10's `PREMIUM_BASIC` is
-- product vocabulary carried by the `family`/`tier` columns. The seeded
-- keys are never renamed (DL-17), and `premium-starter` is the Premium
-- sibling of `starter` for the same reason.
--
-- IDEMPOTENT. Each insert is `SELECT ... WHERE NOT EXISTS`, following
-- `20261009000000`'s own platform access-policy insert. Running this against
-- a database that already has these rows is a no-op — it never rewrites a
-- price, a limit or a status the Platform Owner has since adjusted, which
-- `ON CONFLICT DO UPDATE` could not promise.
--
-- These values are the SQL mirror of `src/plans/utils/plan-catalog.util.ts`
-- and `prisma/seed.ts`, which a migration cannot import. That file is the
-- source of truth; a unit test asserts the six variants and the shared
-- baseline so the pair cannot drift unnoticed.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Premium Starter — the `basic` tier, Premium family
-- ---------------------------------------------------------------------------
INSERT INTO "plans" (
  "id", "key", "name", "description",
  "name_localized", "description_localized",
  "status", "display_order", "family", "tier",
  "limits", "features", "pricing",
  "trial_eligible", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  'premium-starter',
  'Premium Starter',
  'A single academy, with Premium video protection.',
  '{"en": "Premium Starter", "ar": "الأساسية المميزة"}'::jsonb,
  '{"en": "A single academy, with Premium video protection.", "ar": "أكاديمية واحدة، مع حماية فيديو مميزة."}'::jsonb,
  'active'::"plan_status",
  4,
  'premium'::"plan_family",
  'basic'::"plan_tier",
  '{"academies": 1, "students": 20, "instructors": 2, "staff": 2, "courses": 5, "generalStorage": 2, "videoStorage": 2, "videoStorageMinutes": 500, "recordedSessions": 3}'::jsonb,
  '{"cms": true, "seo": false, "seoAdvanced": false, "marketing": false, "marketingAdvanced": false, "analytics": false, "analyticsAdvanced": false, "customDomain": false, "themes": true, "multipleThemes": false, "backup": false, "liveSessions": false}'::jsonb,
  '{"amount": 49, "currency": "USD", "billingCycle": "monthly"}'::jsonb,
  -- Mirrors the Normal counterpart. Trial eligibility is catalog data a
  -- Platform Owner changes without a deploy (`Plan.trialEligible`'s own
  -- doc comment); making this one untrialable would be a revenue decision
  -- nobody has taken.
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "key" = 'premium-starter');


-- ---------------------------------------------------------------------------
-- 2. Premium Growth — the `growth` tier, Premium family
-- ---------------------------------------------------------------------------
INSERT INTO "plans" (
  "id", "key", "name", "description",
  "name_localized", "description_localized",
  "status", "display_order", "family", "tier",
  "limits", "features", "pricing",
  "trial_eligible", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  'premium-growth',
  'Premium Growth',
  'For growing organizations running multiple academies, with Premium video protection.',
  '{"en": "Premium Growth", "ar": "النمو المميز"}'::jsonb,
  '{"en": "For growing organizations running multiple academies, with Premium video protection.", "ar": "للمؤسسات المتنامية التي تدير عدة أكاديميات، مع حماية فيديو مميزة."}'::jsonb,
  'active'::"plan_status",
  5,
  'premium'::"plan_family",
  'growth'::"plan_tier",
  '{"academies": 5, "students": 200, "instructors": 10, "staff": 10, "courses": 50, "generalStorage": 20, "videoStorage": 20, "videoStorageMinutes": 2000, "recordedSessions": 10}'::jsonb,
  '{"cms": true, "seo": true, "seoAdvanced": true, "marketing": true, "marketingAdvanced": false, "analytics": true, "analyticsAdvanced": false, "customDomain": true, "themes": true, "multipleThemes": true, "backup": false, "liveSessions": false}'::jsonb,
  '{"amount": 199, "currency": "USD", "billingCycle": "monthly"}'::jsonb,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "key" = 'premium-growth');


-- ---------------------------------------------------------------------------
-- 3. Premium Enterprise — the `enterprise` tier, Premium family
--
-- `videoStorageMinutes` stays a real number rather than `"unlimited"`,
-- for the same reason the Normal Enterprise plan carries one: D5 sets a
-- ceiling on provider-hosted minutes for every tier, and this would be
-- the single place the catalog stopped bounding a resource with a real
-- cost behind it.
-- ---------------------------------------------------------------------------
INSERT INTO "plans" (
  "id", "key", "name", "description",
  "name_localized", "description_localized",
  "status", "display_order", "family", "tier",
  "limits", "features", "pricing",
  "trial_eligible", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  'premium-enterprise',
  'Premium Enterprise',
  'Unlimited scale for large organizations, with Premium video protection.',
  '{"en": "Premium Enterprise", "ar": "المؤسسات المميزة"}'::jsonb,
  '{"en": "Unlimited scale for large organizations, with Premium video protection.", "ar": "نطاق غير محدود للمؤسسات الكبيرة، مع حماية فيديو مميزة."}'::jsonb,
  'active'::"plan_status",
  6,
  'premium'::"plan_family",
  'enterprise'::"plan_tier",
  '{"academies": "unlimited", "students": "unlimited", "instructors": "unlimited", "staff": "unlimited", "courses": "unlimited", "generalStorage": "unlimited", "videoStorage": "unlimited", "videoStorageMinutes": 5000, "recordedSessions": "unlimited"}'::jsonb,
  '{"cms": true, "seo": true, "seoAdvanced": true, "marketing": true, "marketingAdvanced": true, "analytics": true, "analyticsAdvanced": true, "customDomain": true, "themes": true, "multipleThemes": true, "backup": true, "liveSessions": false}'::jsonb,
  '{"amount": 599, "currency": "USD", "billingCycle": "monthly"}'::jsonb,
  -- Mirrors Normal Enterprise, which is not trialable.
  FALSE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "plans" WHERE "key" = 'premium-enterprise');


-- ---------------------------------------------------------------------------
-- Add-on compatibility follows the TIER, not the family (D10)
--
-- D10 is explicit: "the plan tier determines the commercial limits and
-- features". Before the Premium family existed, `compatible_plan_keys`
-- could simply list `['growth']` and that MEANT "the Growth tier". With
-- six variants the same list silently means "the Normal Growth variant
-- only" — so a paying `premium-growth` customer would be refused an
-- add-on their tier includes, with no message explaining why.
--
-- This is a repair of existing rows, not a new product rule: every
-- Premium variant gains exactly the compatibility its Normal counterpart
-- already had, and nothing gains compatibility its tier did not already
-- carry. Idempotent — appending a key that is already present is a no-op.
-- ---------------------------------------------------------------------------
UPDATE "add_ons"
SET "compatible_plan_keys" = ARRAY(
      SELECT DISTINCT unnest(
        "compatible_plan_keys"
        || CASE WHEN 'starter'    = ANY("compatible_plan_keys") THEN ARRAY['premium-starter']    ELSE ARRAY[]::text[] END
        || CASE WHEN 'growth'     = ANY("compatible_plan_keys") THEN ARRAY['premium-growth']     ELSE ARRAY[]::text[] END
        || CASE WHEN 'enterprise' = ANY("compatible_plan_keys") THEN ARRAY['premium-enterprise'] ELSE ARRAY[]::text[] END
      )
    )
WHERE "key" IN ('live-sessions', 'extra-academy', 'advanced-analytics');
