-- P64 C5 — indexes for the tenant lifecycle sweep.
--
-- `TenantLifecycleService.findCandidates` runs on every subscription-sweep
-- tick and filters `tenant_subscriptions` by `status` plus ONE date
-- column, chosen by which part of the sequence it is evaluating: trial
-- steps by `trial_ends_at`, renewal and grace by `current_period_end`,
-- expiry and the post-expiry follow-ups by `grace_ends_at`. The table
-- carried only `@@index([plan_id])`, so each of those was a sequential
-- scan.
--
-- At today's size that costs nothing measurable, which is the whole
-- argument for doing it now: the index is free to build while the table
-- is small, and the query it fixes runs every fifteen minutes forever.
--
-- Plain `CREATE INDEX`, not `CONCURRENTLY`: Prisma runs each migration
-- inside a transaction and `CONCURRENTLY` cannot run in one. On a table
-- of this size the brief lock is not worth the added deploy complexity
-- of a non-transactional migration — revisit if it ever grows to the
-- point where the write lock matters.

CREATE INDEX IF NOT EXISTS "tenant_subscriptions_status_trial_ends_at_idx"
  ON "tenant_subscriptions" ("status", "trial_ends_at");

CREATE INDEX IF NOT EXISTS "tenant_subscriptions_status_current_period_end_idx"
  ON "tenant_subscriptions" ("status", "current_period_end");

CREATE INDEX IF NOT EXISTS "tenant_subscriptions_status_grace_ends_at_idx"
  ON "tenant_subscriptions" ("status", "grace_ends_at");
