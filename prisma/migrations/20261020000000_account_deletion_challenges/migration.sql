-- Authentication audit, Decision 1: account deletion is confirmed by a code
-- emailed to the account's verified address. One row per request; the code
-- itself is never stored (HMAC with a server key, per-row salt and row id).

CREATE TABLE "account_deletion_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletion_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_deletion_challenges_user_id_created_at_idx"
  ON "account_deletion_challenges"("user_id", "created_at" DESC);

ALTER TABLE "account_deletion_challenges"
  ADD CONSTRAINT "account_deletion_challenges_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the account's own context ever touches its challenges: there is no
-- system-wide read, no platform read, and no cross-user write.
ALTER TABLE "account_deletion_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_deletion_challenges" FORCE ROW LEVEL SECURITY;
CREATE POLICY "account_deletion_challenges_self_select" ON "account_deletion_challenges"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "account_deletion_challenges_self_insert" ON "account_deletion_challenges"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "account_deletion_challenges_self_update" ON "account_deletion_challenges"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "account_deletion_challenges_self_delete" ON "account_deletion_challenges"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));
