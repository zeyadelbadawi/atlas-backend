-- Phase 12 (part 3) — register the Live Sessions add-on in the catalog.
--
-- WHY A MIGRATION. `add_ons` is a PLATFORM-OWNED catalog table, like
-- `plans`. The production deploy runs `prisma migrate deploy` and nothing
-- else, so a row that exists only in `seed.ts` never reaches production —
-- which is exactly what happened after the previous deploy: the Add-ons
-- page rendered its (correct) "no add-ons available yet" empty state
-- because the catalog was genuinely empty.
--
-- WHAT THIS ROW IS. A FEATURE-EFFECT add-on: activating it grants the
-- `liveSessions` capability through the `AddOnFeatureEffect` mechanism
-- that already existed, rather than a bespoke install flag. The recording
-- ALLOWANCE is deliberately NOT here — it lives on the plan
-- (`recordedSessions`), because normal sessions are unlimited and only
-- recording is metered.
--
-- PRICING IS A PLATFORM-OWNER DECISION, not a code constant. The value
-- below is the initial catalog entry; the Platform Owner can change it,
-- make it free (remove `pricing`), or restrict `compatible_plan_keys`
-- without any code change. `ON CONFLICT (key) DO UPDATE` touches only the
-- effect and compatibility — never the price — so re-running this can
-- never silently reset a price the owner has since adjusted.

INSERT INTO "add_ons" ("id", "key", "name", "description", "effect", "compatible_plan_keys", "pricing", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'live-sessions',
  'Live Sessions',
  'Run live classes inside your courses with Zoom, with attendance tracking and optional recording.',
  '{"type": "feature", "featureKey": "liveSessions"}'::jsonb,
  ARRAY['starter', 'growth', 'enterprise'],
  '{"amount": 29, "currency": "USD", "billingCycle": "monthly"}'::jsonb,
  now(),
  now()
)
ON CONFLICT ("key") DO UPDATE SET
  "effect" = EXCLUDED."effect",
  "compatible_plan_keys" = EXCLUDED."compatible_plan_keys",
  "updated_at" = now();
