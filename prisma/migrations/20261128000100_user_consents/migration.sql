-- Atlas mobile app (B4) — consent records: terms, privacy policy and the
-- 13+ age confirmation, with the wording version shown and where (web, ios,
-- android). The app stores them at sign-up (optional `consents` on
-- POST /auth/register) and for existing accounts (POST /users/me/consents).
--
-- WHERE IT LIVES. Its own table, not `users`, for the same reason as
-- `user_phones` (20261110000200_user_phone): `users` is read by rosters and
-- consoles; consent history is the account's own data.
--
-- APPEND-ONLY. A new acceptance is a new row. There is no UPDATE policy, so
-- under FORCE RLS no code path can rewrite a record. DELETE is admitted only
-- for the account itself, and only account deletion uses it: the records
-- are personal data and are erased with the account, like `user_phones`.
--
-- PURELY ADDITIVE. A new table nothing existing reads; the web is unchanged
-- and the previous release keeps working during the deploy window.

CREATE TABLE "user_consents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_consents_user_kind_idx"
  ON "user_consents"("user_id", "kind", "accepted_at" DESC);

ALTER TABLE "user_consents"
  ADD CONSTRAINT "user_consents_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_consents"
  ADD CONSTRAINT "user_consents_kind_check"
  CHECK ("kind" IN ('terms', 'privacy', 'age_13_plus'));
ALTER TABLE "user_consents"
  ADD CONSTRAINT "user_consents_source_check"
  CHECK ("source" IN ('web', 'ios', 'android'));
ALTER TABLE "user_consents"
  ADD CONSTRAINT "user_consents_version_format"
  CHECK ("version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

ALTER TABLE "user_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_consents" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_consents_self_select" ON "user_consents"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_consents_self_insert" ON "user_consents"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_consents_self_delete" ON "user_consents"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));
