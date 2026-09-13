-- Phase 12 (part 2) — put the Live Sessions entitlement keys on every plan.
--
-- WHY THIS IS A MIGRATION AND NOT A SEED STEP. `plans.limits` and
-- `plans.features` are JSONB, so a plan row written before this phase
-- simply has no `recordedSessions` and no `liveSessions` key at all. A
-- MISSING key is not zero and not false — it reads as `undefined`, which
-- makes `RecordingQuotaService`'s arithmetic meaningless and would let
-- `hasFeature` return undefined rather than a decision.
--
-- The seed carries the same backfill, but the seed is a DEVELOPMENT tool:
-- the production deploy runs `prisma migrate deploy` and nothing else, so
-- a seed-only fix would have left every production plan without the keys
-- the new code reads. This is the only mechanism that reaches production.
--
-- `||` merges at the top level and touches nothing else, so it is safe to
-- re-run and cannot clobber a deployment's own tuned values for any other
-- key.

-- The recorded-session allowance per tier. A commercial decision, and the
-- plan catalog is exactly where a commercial decision belongs — not a
-- constant in application code.
UPDATE "plans" SET "limits" = "limits" || '{"recordedSessions": 3}'::jsonb
  WHERE "key" = 'starter';
UPDATE "plans" SET "limits" = "limits" || '{"recordedSessions": 10}'::jsonb
  WHERE "key" = 'growth';
UPDATE "plans" SET "limits" = "limits" || '{"recordedSessions": "unlimited"}'::jsonb
  WHERE "key" = 'enterprise';

-- Any other plan (a custom tier, or one added by a future migration)
-- defaults to 0 rather than being left undefined. Zero is the safe
-- direction for a revenue rule: it means "not entitled to record", which
-- `RecordingQuotaService` reports distinctly from "at your limit".
UPDATE "plans"
   SET "limits" = "limits" || '{"recordedSessions": 0}'::jsonb
 WHERE NOT ("limits" ? 'recordedSessions');

-- The capability itself stays FALSE on every plan. Live Sessions is
-- granted by ACTIVATING the add-on, whose `AddOnFeatureEffect` turns this
-- on through the existing entitlement engine — never bundled silently
-- into a tier.
UPDATE "plans"
   SET "features" = "features" || '{"liveSessions": false}'::jsonb
 WHERE NOT ("features" ? 'liveSessions');
