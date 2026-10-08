-- ============================================================================
-- Remove unenforced plan features.
--
-- RULE: Atlas must never advertise a plan entitlement it does not enforce.
-- Every plan row carried twelve boolean `features`, but only `liveSessions`
-- is ever read by enforcement code (through the Live Sessions add-on effect,
-- `AddOnAccessService`). The other eleven — cms, seo, seoAdvanced,
-- marketing, marketingAdvanced, analytics, analyticsAdvanced, customDomain,
-- themes, multipleThemes, backup — gated nothing, yet the pricing page and
-- the subscription screens presented them as plan-specific. The application
-- no longer reads or returns them (`PLAN_FEATURE_KEYS` is `liveSessions`
-- only, and `pickPlanFeatures` narrows every read); this removes them from
-- the stored data as well. Numeric `limits` are enforced and untouched.
--
-- 1. `plans.features` — the eleven keys are removed from every row that
--    still has any of them. `liveSessions` is kept exactly as stored. The
--    `version` bump makes a plan editor opened before this migration reload
--    instead of silently writing over the cleaned row.
--
-- 2. `add_ons` `advanced-analytics` — its effect grants `analyticsAdvanced`,
--    one of the removed keys, so selling it would be selling nothing. It is
--    moved to `draft` (hidden from the customer store and not installable)
--    rather than deleted: `tenant_add_ons` rows reference it, and install
--    history must stay intact. Its stored effect is left as-is;
--    `EntitlementService` ignores a feature effect naming a removed key.
--
-- DATA ONLY. No table, column, type, policy or grant changes: `plans` and
-- `add_ons` are platform-owned catalog tables without RLS, and these
-- UPDATEs run as the migration role. Idempotent — a second run matches no
-- rows.
-- ============================================================================

UPDATE "plans"
SET "features" = "features" - ARRAY['cms', 'seo', 'seoAdvanced', 'marketing', 'marketingAdvanced', 'analytics', 'analyticsAdvanced', 'customDomain', 'themes', 'multipleThemes', 'backup'],
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "features" ?| ARRAY['cms', 'seo', 'seoAdvanced', 'marketing', 'marketingAdvanced', 'analytics', 'analyticsAdvanced', 'customDomain', 'themes', 'multipleThemes', 'backup'];

UPDATE "add_ons"
SET "catalog_status" = 'draft',
    "version" = "version" + 1,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'advanced-analytics'
  AND "catalog_status" <> 'draft';
