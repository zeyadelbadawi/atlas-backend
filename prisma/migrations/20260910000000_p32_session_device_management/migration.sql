-- Phase 10 — Session & Device Management (roadmap Phase 10, Decision 7).
--
-- Purely additive: four new columns and one index on `refresh_tokens`.
-- No column is dropped or retyped, no row is deleted, and no existing
-- authentication history is destroyed — every currently-valid refresh
-- token remains valid and usable across this migration.
--
-- `session_id` is the only NOT NULL addition, and it is populated in the
-- same migration that adds it, so there is never a window where a row
-- exists without one:
--
--   1. Added nullable.
--   2. Backfilled to each row's OWN `id`. This specific choice is what
--      makes the deploy non-breaking. `RefreshTokensRepository.rotate`
--      revokes the presented row and INSERTS a new one on every refresh,
--      so a row id identifies one link in a rotation chain rather than a
--      device. Going forward `session_id` is minted once at sign-in and
--      copied forward by each rotation. For rows that already exist there
--      is no recorded chain to reconstruct, so each is treated as its own
--      single-link session. Because an access token already in
--      circulation carries `sid` = its row id, that value now equals the
--      `session_id` of the very same session — so every token issued
--      before this migration keeps resolving correctly afterwards.
--   3. Set NOT NULL once every row is guaranteed populated.
--
-- `ip_address`, `user_agent` and `last_used_at` stay nullable on purpose.
-- Rows created before this migration genuinely have no recorded IP, user
-- agent or activity timestamp, and inventing one — "unknown", the
-- server's own address, or `created_at` reused as activity — would be
-- fabricated session data presented to a user as though it were real.
-- The session list renders these as honestly unknown instead.
ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" TEXT;
UPDATE "refresh_tokens" SET "session_id" = "id" WHERE "session_id" IS NULL;
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;

ALTER TABLE "refresh_tokens" ADD COLUMN "ip_address" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "user_agent" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" TIMESTAMP(3);

-- Every session read is "all rows in this rotation family", and revocation
-- updates the family as a unit, so this is the access path both new
-- endpoints depend on.
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");
