-- Atlas mobile app (B2) — Sign in with Apple.
--
-- 1. `apple` joins the two enums Google added (20261019000000):
--    `user_auth_identities.provider` and the session's first factor
--    (`refresh_tokens.auth_method`, `auth_email_challenges.auth_method`).
--    ADD VALUE only: no existing row or reader changes, and the new value is
--    first used by code shipped with this migration.
--
-- 2. `apple_refresh_tokens` — Apple requires apps that offer Sign in with
--    Apple to revoke the user's Apple tokens when the account is deleted.
--    Revocation needs a token Apple issued to us, so the refresh token from
--    the authorization-code exchange is kept, AES-256-GCM sealed by the
--    application (never readable in the database), one row per account.
--    FORCE RLS, own row only; erased with the account.
--
-- PURELY ADDITIVE. The web never offers Apple; nothing it reads changes.

ALTER TYPE "auth_identity_provider" ADD VALUE IF NOT EXISTS 'apple';
ALTER TYPE "auth_method" ADD VALUE IF NOT EXISTS 'apple';

CREATE TABLE "apple_refresh_tokens" (
    "user_id" TEXT NOT NULL,
    "sealed_token" TEXT NOT NULL,
    "client_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apple_refresh_tokens_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "apple_refresh_tokens"
  ADD CONSTRAINT "apple_refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "apple_refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "apple_refresh_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY "apple_refresh_tokens_self_select" ON "apple_refresh_tokens"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "apple_refresh_tokens_self_insert" ON "apple_refresh_tokens"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "apple_refresh_tokens_self_update" ON "apple_refresh_tokens"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "apple_refresh_tokens_self_delete" ON "apple_refresh_tokens"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));
