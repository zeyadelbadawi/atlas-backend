-- Production-readiness pass — the password credential leaves the identity
-- directory.
--
-- WHY. `users` is the identity DIRECTORY: rosters, reviews, certificates, audit
-- actors, search and the platform console all read it, legitimately, inside
-- any established context (20261021000000_identity_tables_rls). While the
-- Argon2 hash lived on that row, every full-row read — `findById`, the one
-- `include: { user: true }` — carried a credential into application memory,
-- and the only things keeping it off the wire or out of a log were mapping
-- discipline and a redaction list. Column privileges or a query-level `omit`
-- would still leave the hash on the directory row, one careless query away.
-- The strong fix is structural: the credential is not on the directory row.
--
-- THE MODEL.
--   * `user_credentials(user_id PK → users ON DELETE CASCADE, password_hash)`
--     with FORCE ROW LEVEL SECURITY, admitted only in the owner's own
--     `app.current_user_id` context for every command — the same strictly
--     per-user rule as `refresh_tokens` and `user_two_factor`. No platform
--     owner policy: nobody has a reason to read another account's hash.
--   * No row = the account has no password (Google-only, invited, deleted).
--     This replaces the `nopassword:` / `deleted:` sentinel strings, so "has a
--     usable password" is a fact of the schema, not a string convention.
--
-- STAGED REMOVAL OF THE OLD COLUMN. Migrations run while the previous release
-- is still serving (for the seconds before its container is recreated), and
-- that release selects `users.password_hash` on every user read. Dropping the
-- column here would break every user query in that window. Instead:
--   1. every real Argon2 hash is copied into `user_credentials`;
--   2. `users.password_hash` becomes nullable and is set to NULL everywhere —
--      from this moment the directory holds no credential;
--   3. a trigger captures any write the previous release makes in that window
--      (a registration, a password change) into `user_credentials` and keeps
--      the column NULL, so nothing is lost and nothing re-appears.
-- A follow-up migration drops the column and the trigger once no release
-- reads it. The only effect of the window: a password sign-in served by the
-- OLD container in those seconds fails (it reads NULL) — no data changes.
--
-- FAILS CLOSED. The backfill is verified in the same transaction: if the
-- number of copied credentials differs from the number of Argon2 hashes in
-- `users`, the migration raises and rolls back entirely.

-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
CREATE TABLE "user_credentials" (
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_credentials_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a well-formed Argon2 PHC string is a credential.
ALTER TABLE "user_credentials"
  ADD CONSTRAINT "user_credentials_password_hash_argon2"
  CHECK ("password_hash" LIKE '$argon2%');

ALTER TABLE "user_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_credentials" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_credentials_self_select" ON "user_credentials"
  FOR SELECT USING ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_credentials_self_insert" ON "user_credentials"
  FOR INSERT WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_credentials_self_update" ON "user_credentials"
  FOR UPDATE USING ("user_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id" = current_setting('app.current_user_id', true));
CREATE POLICY "user_credentials_self_delete" ON "user_credentials"
  FOR DELETE USING ("user_id" = current_setting('app.current_user_id', true));

-- ---------------------------------------------------------------------------
-- 2. Backfill, verified.
-- ---------------------------------------------------------------------------
INSERT INTO "user_credentials" ("user_id", "password_hash", "created_at", "updated_at")
SELECT u."id", u."password_hash", now(), now()
  FROM "users" u
 WHERE u."password_hash" LIKE '$argon2%';

DO $$
DECLARE
  expected integer;
  copied integer;
BEGIN
  SELECT count(*) INTO expected FROM "users" WHERE "password_hash" LIKE '$argon2%';
  SELECT count(*) INTO copied FROM "user_credentials";
  IF expected <> copied THEN
    RAISE EXCEPTION 'user_credentials backfill mismatch: % argon2 hashes, % copied', expected, copied;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. The directory stops holding credentials.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
UPDATE "users" SET "password_hash" = NULL WHERE "password_hash" IS NOT NULL;

-- The previous release's writes during the deploy window land in
-- `user_credentials` instead. SECURITY DEFINER so it works whatever context
-- the old code had set; it only ever writes the row of the user being
-- written, and only a well-formed Argon2 hash (the old sentinels mean "no
-- password" and remove the credential).
CREATE FUNCTION users_capture_legacy_password_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW."password_hash" IS NOT NULL THEN
    IF NEW."password_hash" LIKE '$argon2%' THEN
      INSERT INTO "user_credentials" ("user_id", "password_hash", "created_at", "updated_at")
      VALUES (NEW."id", NEW."password_hash", now(), now())
      ON CONFLICT ("user_id") DO UPDATE
        SET "password_hash" = EXCLUDED."password_hash", "updated_at" = now();
    ELSIF TG_OP = 'UPDATE' THEN
      DELETE FROM "user_credentials" WHERE "user_id" = NEW."id";
    END IF;
    NEW."password_hash" := NULL;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION users_capture_legacy_password_hash() FROM PUBLIC;

-- AFTER-insert semantics are needed for the FK on a brand-new user, so the
-- INSERT case is handled by an AFTER trigger that re-reads NEW; the UPDATE
-- case can run BEFORE and clear the column in place.
CREATE TRIGGER "users_capture_legacy_password_hash_update"
  BEFORE UPDATE OF "password_hash" ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_capture_legacy_password_hash();

CREATE FUNCTION users_capture_legacy_password_hash_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW."password_hash" IS NOT NULL THEN
    IF NEW."password_hash" LIKE '$argon2%' THEN
      INSERT INTO "user_credentials" ("user_id", "password_hash", "created_at", "updated_at")
      VALUES (NEW."id", NEW."password_hash", now(), now())
      ON CONFLICT ("user_id") DO UPDATE
        SET "password_hash" = EXCLUDED."password_hash", "updated_at" = now();
    END IF;
    UPDATE "users" SET "password_hash" = NULL WHERE "id" = NEW."id";
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION users_capture_legacy_password_hash_insert() FROM PUBLIC;

CREATE TRIGGER "users_capture_legacy_password_hash_insert"
  AFTER INSERT ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_capture_legacy_password_hash_insert();

-- Privileges on the column are left as they are until the follow-up
-- migration drops it: the previous release names it in its reads, inserts
-- and password updates, and the triggers above make every such write land in
-- `user_credentials` while the column itself stays NULL.
