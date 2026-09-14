-- P47 — lifecycle bookkeeping for the Live Sessions sweep.
--
-- Three columns, all NULLABLE or DEFAULTED, so this is safe against a
-- non-empty production table: `ADD COLUMN NOT NULL` with no default would
-- abort the deploy the moment `live_sessions` has a single row (the exact
-- failure mode caught in P44 on `tenant_add_ons`).
--
-- WHY THESE EXIST RATHER THAN DERIVING THEM. The sweep runs every few
-- minutes across every tenant; "has this already been handled?" must be a
-- cheap indexed predicate, not a scan of notifications or attendance rows.

ALTER TABLE "live_sessions"
  ADD COLUMN IF NOT EXISTS "starting_soon_notified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "attendance_reconciled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reconciliation_attempts" INTEGER NOT NULL DEFAULT 0;

-- The sweep's two queries, each supported by a PARTIAL index so the index
-- stays proportional to the work outstanding rather than to the table.
-- A platform with a million historical sessions still scans only those
-- actually awaiting a reminder or a reconciliation.

-- Sessions due a starting-soon reminder: scheduled, not yet reminded.
CREATE INDEX IF NOT EXISTS "live_sessions_starting_soon_due_idx"
  ON "live_sessions" ("scheduled_start_at")
  WHERE "starting_soon_notified_at" IS NULL AND "status" = 'scheduled';

-- Sessions due attendance reconciliation: ended, not yet reconciled.
CREATE INDEX IF NOT EXISTS "live_sessions_reconciliation_due_idx"
  ON "live_sessions" ("ended_at")
  WHERE "attendance_reconciled_at" IS NULL AND "status" = 'ended';
