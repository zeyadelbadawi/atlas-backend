-- ============================================================================
-- Phase 2 — Entitlement & Plan Enforcement (master plan §21 Phase P22).
--
-- Two independent, additive fixes:
--
-- 1. `trial_policy.duration_days` — Decision 6 (roadmap §1) locks the free
--    trial at exactly 3 days, explicitly superseding the 7-day figure this
--    column's default (and `TrialPolicyRepository.DEFAULT_DURATION_DAYS`,
--    fixed in the same commit as this migration) previously carried. The
--    `UPDATE` is conditional (`WHERE duration_days = 7`) — it only corrects
--    the pre-existing, never-deliberately-chosen default this codebase
--    itself created; a real deployment that had already used `PATCH
--    /trial-policy` to intentionally set some OTHER value is left
--    untouched, matching this phase's "avoid destructive changes unless
--    absolutely required" instruction. `trial_policy` has at most one row
--    (see that model's own doc comment), so this is a single-row update at
--    most, never a bulk rewrite.
--
-- 2. `tenant_subscriptions_platform_update` — the new automatic trial-
--    expiry sweep (`SubscriptionExpiryService`, running under
--    `runInUserContext(<a real platform-owner id>)`, mirroring every other
--    Platform Owner cross-tenant job in this codebase) needs to transition
--    ANY organization's `tenant_subscriptions.status` to `'expired'`
--    system-wide — `tenant_subscriptions_platform_select` (P15) already
--    lets the Platform Owner READ every organization's subscription, but
--    no matching UPDATE policy has ever existed (the only pre-existing
--    write policy, `tenant_subscriptions_tenant_update` from P12, is
--    scoped to the row's OWN organization context, which the sweep job —
--    genuinely cross-tenant — never has). Adds the same shape every
--    sibling `_platform_select`/`_platform_update` pair in this schema
--    already uses.
-- ============================================================================

UPDATE "trial_policy" SET "duration_days" = 3 WHERE "duration_days" = 7;

ALTER TABLE "trial_policy" ALTER COLUMN "duration_days" SET DEFAULT 3;

CREATE POLICY "tenant_subscriptions_platform_update" ON "tenant_subscriptions"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
