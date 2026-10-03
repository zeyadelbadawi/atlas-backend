-- ============================================================================
-- W4 follow-up (security review, finding 1) — a deleted account never takes
-- part in learner-name uniqueness, and a rename releases an exemption it no
-- longer needs.
--
-- THE BUG
--   Account deletion anonymises `users.name` to 'Deleted account'. The M1
--   trigger `users_learner_name_key_au` then copied that name's key into every
--   academy_students row the account still had, and M3's partial unique index
--   (`academy_students_academy_id_name_key_key`, WHERE NOT name_unique_exempt)
--   refused the SECOND deleted learner of the same academy: deletion failed
--   with P2002 → 500. (The application half — learner studentships were not
--   removed on deletion — is fixed in AccountDeletionService.)
--
-- WHAT THIS CHANGES (functions and one trigger are redefined; nothing is
-- dropped that holds data, and M3's index and predicate are unchanged)
--   * A user is DELETED when `status = 'deleted'` OR `deleted_at IS NOT NULL`
--     (the two representations the application already treats as one, e.g.
--     CommunicationDispatchService). Every academy_students row of a deleted
--     user is `name_unique_exempt = true`:
--       - `users_sync_learner_name_key()` sets it in the same statement that
--         moves the key, so the anonymised key never enters the index;
--       - `academy_students_set_name_key()` (BEFORE INSERT / UPDATE OF
--         user_id, name_key, name_unique_exempt) forces it, so no later write
--         can bring a deleted user's row back into the index;
--       - the trigger now also fires when an account BECOMES deleted without
--         a rename (status / deleted_at only).
--   * A rename by a live account releases each exemption whose academy no
--     longer has another non-exempt learner on the new key (sets it false).
--     This is what lets a learner admitted exempt ("please choose a different
--     display name", finding 2) become an ordinary, protected name again.
--     The application takes the per-(academy, key) advisory lock for every
--     academy of the account before renaming (UsersService), so the check and
--     the release cannot race an admission that also locks; any writer that
--     skips the lock is still stopped by the unique index.
--   * Backfill: existing rows of deleted users are marked exempt (local data:
--     the retained 'deleted account' / 'deleted person' rows). Each changed
--     row is first copied to `atlas_migration_backups` (the W4 M4 / W8
--     convention: outside Prisma's view, never readable by the application).
--
-- M3 CONSISTENCY
--   The M3 guard counted duplicates among NOT name_unique_exempt rows; the
--   index and `academy_learner_name_taken()` use the same predicate. Marking
--   deleted users exempt keeps all three in agreement, and the postcondition
--   below re-runs the M3 duplicate check.
--
-- SAFETY: one transaction; `lock_timeout` fails fast instead of queueing.
-- Idempotent (CREATE OR REPLACE, IF NOT EXISTS, the backfill only touches
-- rows not yet exempt).
--
-- RECOVERY (restores the previous flags; only rows still exempt):
--   UPDATE academy_students s SET name_unique_exempt = b.previous_exempt
--     FROM atlas_migration_backups.w4_backup_deleted_learner_exemptions b
--    WHERE b.id = s.id AND s.name_unique_exempt;
--   and re-apply the M1 definitions of users_sync_learner_name_key(),
--   academy_students_set_name_key() and their triggers
--   (20261104000300_w4_name_key_foundation). Note the recovery re-introduces
--   the deletion failure it fixed.
-- ============================================================================

SET LOCAL lock_timeout = '10s';

-- Writers wait while the backfill runs (milliseconds).
LOCK TABLE "academy_students" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Backup table (operator-only), then the backfill.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS atlas_migration_backups;
REVOKE ALL ON SCHEMA atlas_migration_backups FROM PUBLIC;

CREATE TABLE IF NOT EXISTS atlas_migration_backups."w4_backup_deleted_learner_exemptions" (
  "id"              text        NOT NULL,
  "academy_id"      text        NOT NULL,
  "user_id"         text        NOT NULL,
  "name_key"        text        NOT NULL,
  "previous_exempt" boolean     NOT NULL,
  "run_at"          timestamptz NOT NULL,
  PRIMARY KEY ("id", "run_at")
);

DO $$
BEGIN
  REVOKE ALL ON TABLE atlas_migration_backups."w4_backup_deleted_learner_exemptions" FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
    REVOKE ALL ON TABLE atlas_migration_backups."w4_backup_deleted_learner_exemptions" FROM "atlas_app";
  END IF;
  ALTER TABLE atlas_migration_backups."w4_backup_deleted_learner_exemptions" ENABLE ROW LEVEL SECURITY;
  ALTER TABLE atlas_migration_backups."w4_backup_deleted_learner_exemptions" FORCE ROW LEVEL SECURITY;
END
$$;

DO $$
DECLARE
  v_run_at  timestamptz := clock_timestamp();
  v_changed integer;
BEGIN
  INSERT INTO atlas_migration_backups."w4_backup_deleted_learner_exemptions"
    ("id", "academy_id", "user_id", "name_key", "previous_exempt", "run_at")
  SELECT s."id", s."academy_id", s."user_id", s."name_key", s."name_unique_exempt", v_run_at
    FROM "academy_students" s
    JOIN "users" u ON u."id" = s."user_id"
   WHERE (u."status" = 'deleted' OR u."deleted_at" IS NOT NULL)
     AND NOT s."name_unique_exempt";

  UPDATE "academy_students" s
     SET "name_unique_exempt" = true
    FROM "users" u
   WHERE u."id" = s."user_id"
     AND (u."status" = 'deleted' OR u."deleted_at" IS NOT NULL)
     AND NOT s."name_unique_exempt";
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RAISE NOTICE 'w4_deleted_learner_name_exemption: % deleted-learner row(s) marked exempt', v_changed;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. BEFORE INSERT / UPDATE on academy_students: the key is always the
--    account's, and a deleted account's row is always exempt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION academy_students_set_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  SELECT atlas_name_key(u."name"), (u."status" = 'deleted' OR u."deleted_at" IS NOT NULL)
    INTO NEW."name_key", v_deleted
    FROM "users" u
   WHERE u."id" = NEW."user_id";
  NEW."name_key" := coalesce(NEW."name_key", '');
  IF coalesce(v_deleted, false) THEN
    NEW."name_unique_exempt" := true;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION academy_students_set_name_key() FROM PUBLIC;

DROP TRIGGER IF EXISTS academy_students_name_key_biu ON "academy_students";
CREATE TRIGGER academy_students_name_key_biu
  BEFORE INSERT OR UPDATE OF "user_id", "name_key", "name_unique_exempt" ON "academy_students"
  FOR EACH ROW EXECUTE FUNCTION academy_students_set_name_key();

-- ---------------------------------------------------------------------------
-- 3. AFTER UPDATE on users: follow a rename; exempt a deleted account;
--    release exemptions a live account's new name no longer needs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_sync_learner_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text := coalesce(atlas_name_key(NEW."name"), '');
BEGIN
  IF NEW."status" = 'deleted' OR NEW."deleted_at" IS NOT NULL THEN
    -- Key and exemption in ONE statement: the anonymised key never enters
    -- the partial unique index, so two deleted learners of one academy can
    -- never collide.
    UPDATE "academy_students"
       SET "name_key" = k,
           "name_unique_exempt" = true
     WHERE "user_id" = NEW."id"
       AND ("name_key" IS DISTINCT FROM k OR NOT "name_unique_exempt");
    RETURN NULL;
  END IF;

  UPDATE "academy_students"
     SET "name_key" = k
   WHERE "user_id" = NEW."id"
     AND "name_key" IS DISTINCT FROM k;

  IF OLD."name" IS DISTINCT FROM NEW."name" THEN
    UPDATE "academy_students" s
       SET "name_unique_exempt" = false
     WHERE s."user_id" = NEW."id"
       AND s."name_unique_exempt"
       AND s."name_key" <> ''
       AND NOT EXISTS (
         SELECT 1 FROM "academy_students" o
          WHERE o."academy_id" = s."academy_id"
            AND o."name_key" = s."name_key"
            AND NOT o."name_unique_exempt"
            AND o."user_id" <> s."user_id"
       );
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION users_sync_learner_name_key() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_learner_name_key_au ON "users";
CREATE TRIGGER users_learner_name_key_au
  AFTER UPDATE OF "name", "status", "deleted_at" ON "users"
  FOR EACH ROW
  WHEN (
    OLD."name" IS DISTINCT FROM NEW."name"
    OR (
      (NEW."status" = 'deleted' OR NEW."deleted_at" IS NOT NULL)
      AND NOT (OLD."status" = 'deleted' OR OLD."deleted_at" IS NOT NULL)
    )
  )
  EXECUTE FUNCTION users_sync_learner_name_key();

-- ---------------------------------------------------------------------------
-- 4. Postconditions: no deleted account is in the index, and M3's own
--    duplicate check still holds.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_deleted_in_index integer;
  v_dup_groups       integer;
BEGIN
  SELECT count(*) INTO v_deleted_in_index
    FROM "academy_students" s
    JOIN "users" u ON u."id" = s."user_id"
   WHERE (u."status" = 'deleted' OR u."deleted_at" IS NOT NULL)
     AND NOT s."name_unique_exempt";
  SELECT count(*) INTO v_dup_groups
    FROM (SELECT 1 FROM "academy_students" WHERE NOT "name_unique_exempt"
           GROUP BY "academy_id", "name_key" HAVING count(*) > 1) g;
  IF v_deleted_in_index + v_dup_groups > 0 THEN
    RAISE EXCEPTION
      'w4_deleted_learner_name_exemption: postcondition failed (deleted rows in index %, duplicate groups %)',
      v_deleted_in_index, v_dup_groups;
  END IF;
END
$$;

ANALYZE "academy_students";
