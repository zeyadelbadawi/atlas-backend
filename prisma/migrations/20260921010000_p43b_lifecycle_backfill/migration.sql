-- Phase 11 (part 2) — assign the states added by `p43` to existing rows.
--
-- Separate migration because PostgreSQL will not let a transaction use an
-- enum value it added itself; see `p43`'s closing comment.
--
-- EVERY STATEMENT HERE IS A REINTERPRETATION, NEVER A LOSS. No row is
-- deleted, no entitlement is granted, and nothing that was `active`,
-- `trialing`, `past_due`, `paused`, `grace_period` or `cancelled` is
-- touched at all. Only rows currently sitting in the overloaded `expired`
-- bucket are re-sorted into the more precise state they always actually
-- were, and a row that does not match a rule below keeps `expired` —
-- which remains the correct answer for a genuinely lapsed paid
-- subscription.

-- 1. The catalog rule. Starter and Growth are the self-service trial
--    tiers; Enterprise is sold with a conversation, not a 3-day trial.
--    Written against `key` (stable, machine-facing) rather than `name`
--    (display text that may be translated or rebranded).
UPDATE "plans" SET "trial_eligible" = true WHERE "key" IN ('starter', 'growth');

-- 2. NEVER HAD ANYTHING -> no_plan.
--
--    Identified by the complete absence of history, not by a guess: no
--    trial clock was ever set, no paid period ever closed, and no trial
--    redemption was ever recorded against the organization. That is the
--    exact row `OrganizationSubscriptionBootstrapService` writes for a
--    workspace created moments ago.
--
--    `trial_redemptions` is consulted because it is the one record that
--    deliberately OUTLIVES the things it references (see that table's own
--    doc comment) — it is the only trustworthy evidence that a trial once
--    happened, precisely because `markExpired` erased `trial_ends_at`.
UPDATE "tenant_subscriptions" ts
SET "status" = 'no_plan'
WHERE ts."status" = 'expired'
  AND ts."trial_ends_at" IS NULL
  AND ts."current_period_end" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "trial_redemptions" tr
    WHERE tr."organization_id" = ts."organization_id"
  );

-- 3. A TRIAL ENDED -> trial_expired.
--
--    A redemption exists for this organization and no paid period ever
--    closed, so what lapsed was the trial, not a subscription. The plan
--    already on the row is the plan that was trialed, which is what makes
--    "Continue with Growth" possible as a recovery action.
UPDATE "tenant_subscriptions" ts
SET "status" = 'trial_expired'
WHERE ts."status" = 'expired'
  AND ts."current_period_end" IS NULL
  AND EXISTS (
    SELECT 1 FROM "trial_redemptions" tr
    WHERE tr."organization_id" = ts."organization_id"
  );

-- 4. Restore the trial end date the old sweep threw away.
--
--    `markExpired` used to null `trial_ends_at`, so these rows know they
--    were trials but not when they ended. The redemption kept the date;
--    copy it back so the recovery screen can say "your trial ended on
--    <date>" truthfully instead of omitting it. Only fills genuine gaps
--    (`IS NULL`) — never overwrites a date already present.
UPDATE "tenant_subscriptions" ts
SET "trial_ends_at" = tr."trial_ends_at"
FROM "trial_redemptions" tr
WHERE tr."organization_id" = ts."organization_id"
  AND ts."status" = 'trial_expired'
  AND ts."trial_ends_at" IS NULL
  AND tr."trial_ends_at" IS NOT NULL;
