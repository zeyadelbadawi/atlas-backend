-- =============================================================================
-- W3 (Atlas Large-Scale Initiative) — Academy Email Activity index and
-- authentication-challenge retention.
--
-- 1. `communication_outbox (academy_id, created_at DESC, id DESC)` WHERE
--    academy_id IS NOT NULL. Backs the Platform Owner's "Academy Email
--    Activity" page (`GET platform-communications/email-activity`), which
--    reads one academy's rows newest-first with a keyset cursor
--    `(created_at, id) < ($cursorCreatedAt, $cursorId)`. Without it every
--    page is a scan of the whole outbox (there was no academy index at all).
--    Partial, because most platform-wide rows (lifecycle, billing) carry no
--    academy and would only bloat it. Plain CREATE INDEX (not CONCURRENTLY):
--    Prisma runs each migration in a transaction, as
--    `20261016000000_p64_c5_lifecycle_sweep_indexes` documents.
--
-- 2. `account_deletion_challenges_retention_delete` — rows older than 24 h
--    may be deleted. The table had only a self-delete policy, so the new
--    daily security-maintenance sweep (running as a platform owner) could
--    not prune it; `auth_email_challenges` already has the identical 24 h
--    retention policy (`20261013000000_p64_comm_foundation`) but no job ever
--    ran it. Both tables hold only HMACs, salts, counters and (for the OTP
--    table) the raw client IP of the sign-in — none of it is needed once the
--    10-minute challenge is long dead. The sweep issues an UNQUALIFIED
--    DELETE (no WHERE), so PostgreSQL applies only these DELETE policies and
--    not the self-only SELECT policies — the `notifications` precedent.
--
-- Additive: one index, one policy. Rollback:
--   DROP INDEX "communication_outbox_academy_id_created_at_id_idx";
--   DROP POLICY "account_deletion_challenges_retention_delete" ON "account_deletion_challenges";
-- =============================================================================

CREATE INDEX IF NOT EXISTS "communication_outbox_academy_id_created_at_id_idx"
  ON "communication_outbox" ("academy_id", "created_at" DESC, "id" DESC)
  WHERE "academy_id" IS NOT NULL;

CREATE POLICY "account_deletion_challenges_retention_delete" ON "account_deletion_challenges"
  FOR DELETE USING ("created_at" < now() - INTERVAL '24 hours');
