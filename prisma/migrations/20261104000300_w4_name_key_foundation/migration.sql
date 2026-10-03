-- ============================================================================
-- W4 (M1 of 3) — name keys for organization, academy and learner uniqueness.
--
-- WHAT THIS ADDS (no constraint yet; M3 adds the unique indexes)
--
--   * `atlas_name_key(text)` — the ONE normalization every uniqueness rule
--     compares on. IMMUTABLE, so it can back a generated column and an index:
--       1. normalize(NFKD)
--       2. strip combining marks and invisibles: Latin marks U+0300–036F,
--          Arabic harakat/hamza marks U+064B–065F (after NFKD this folds
--          أ إ آ ؤ ئ to ا ا ا و ي), superscript alef U+0670, Quranic marks
--          U+06D6–06ED, tatweel U+0640, zero-width/bidi controls
--          U+200B–200F, U+202A–202E, U+2060–2069 and the BOM U+FEFF
--       3. lower() under the ICU root collation — the database ctype is `C`,
--          where plain lower() leaves É, Σ, … unchanged
--       4. Greek final sigma ς → σ
--       5. normalize(NFKC) — folds full-width letters, ligatures, Arabic
--          presentation forms and NBSP
--       6. collapse whitespace runs to one space, trim
--     Deliberately NOT folded (product default, conservative): ى/ي, ة/ه,
--     Arabic-Indic digits, punctuation. The TypeScript mirror
--     (`src/common/name-uniqueness/name-key.ts`) is for form messages only;
--     this function is authoritative.
--   * `organizations.name_key`, `academies.name_key` — STORED GENERATED
--     columns (the p65 `search_vector` precedent): every write path —
--     create, update, branding, provisioning, seeds, scripts — maintains
--     them with no application code.
--   * `academy_students.name_key` + `name_unique_exempt`. A learner has no
--     name of its own (it is `users.name`, global per account), so the key
--     is copied from the account and kept in step by two SECURITY DEFINER
--     triggers. `name_unique_exempt` marks a row that is allowed to share
--     its key (automatic admissions and legacy duplicates — never renamed).
--   * Boolean-only SECURITY DEFINER checks, granted to `atlas_app`, so the
--     application can pre-check and classify a unique violation without
--     seeing other tenants' rows (RLS hides them, by design).
--
-- SAFETY
--   * Additive only. Adding a STORED generated column rewrites
--     `organizations` and `academies` under ACCESS EXCLUSIVE; at current
--     sizes (prod ~tens of rows, local ~1.4k) that is milliseconds.
--     `lock_timeout` makes it fail fast instead of queueing sign-ins.
--   * Idempotent statements (IF NOT EXISTS / OR REPLACE), so a timed-out run
--     can be marked rolled back and re-deployed.
--   * Reversal (if ever needed, before M3):
--       DROP TRIGGER users_learner_name_key_au ON users;
--       DROP TRIGGER academy_students_name_key_biu ON academy_students;
--       ALTER TABLE academy_students DROP COLUMN name_key, DROP COLUMN name_unique_exempt;
--       ALTER TABLE academies DROP COLUMN name_key;
--       ALTER TABLE organizations DROP COLUMN name_key;
--       DROP FUNCTION academy_learner_admission_name_taken(text, text),
--         academy_learner_name_taken(text, text, text), academy_name_taken(text, text),
--         organization_name_taken(text), users_sync_learner_name_key(),
--         academy_students_set_name_key(), atlas_name_key(text);
-- ============================================================================

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions.
-- ---------------------------------------------------------------------------
-- The definer triggers and checks must read past FORCE RLS (identity_tables_rls
-- precedent), and the key needs ICU case mapping. Refuse rather than install a
-- key that silently behaves differently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'w4_name_key_foundation: the migrating role % must be SUPERUSER or BYPASSRLS so the SECURITY DEFINER checks can read past RLS',
      current_user;
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'w4_name_key_foundation: normalize() requires a UTF8 database (found %)',
      current_setting('server_encoding');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') THEN
    RAISE EXCEPTION 'w4_name_key_foundation: the ICU collation "und-x-icu" is missing (PostgreSQL built without ICU?)';
  END IF;
  -- Functional probe: ICU must case-map non-ASCII letters.
  IF lower('ÉΣA' COLLATE "und-x-icu") <> 'éσa' THEN
    RAISE EXCEPTION 'w4_name_key_foundation: ICU lower() does not case-map non-ASCII letters';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. The key function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION atlas_name_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT btrim(
    regexp_replace(
      normalize(
        translate(
          lower(
            regexp_replace(
              normalize(p, NFKD),
              '[̀-ًͯ-ٰٟۖ-ۭـ​-‏‪-‮⁠-⁩﻿]',
              '',
              'g'
            ) COLLATE "und-x-icu"
          ),
          'ς',
          'σ'
        ),
        NFKC
      ),
      '\s+',
      ' ',
      'g'
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- 2. Generated keys on organizations and academies.
-- ---------------------------------------------------------------------------
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "name_key" text
  GENERATED ALWAYS AS (atlas_name_key("name")) STORED;
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "name_key" text
  GENERATED ALWAYS AS (atlas_name_key("name")) STORED;

-- ---------------------------------------------------------------------------
-- 3. Learner key, copied from the account name, plus the exemption flag.
-- ---------------------------------------------------------------------------
ALTER TABLE "academy_students"
  ADD COLUMN IF NOT EXISTS "name_key" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "name_unique_exempt" boolean NOT NULL DEFAULT false;

UPDATE "academy_students" s
   SET "name_key" = atlas_name_key(u."name")
  FROM "users" u
 WHERE u."id" = s."user_id"
   AND s."name_key" IS DISTINCT FROM atlas_name_key(u."name");

-- BEFORE INSERT (and any write that changes who the row is, or tries to set
-- the key directly): the key is always the account's, never the caller's.
-- SECURITY DEFINER because a self-registering learner or a staff member may
-- not be able to read the account row under RLS.
CREATE OR REPLACE FUNCTION academy_students_set_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT atlas_name_key(u."name") INTO NEW."name_key"
    FROM "users" u
   WHERE u."id" = NEW."user_id";
  NEW."name_key" := coalesce(NEW."name_key", '');
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION academy_students_set_name_key() FROM PUBLIC;

DROP TRIGGER IF EXISTS academy_students_name_key_biu ON "academy_students";
CREATE TRIGGER academy_students_name_key_biu
  BEFORE INSERT OR UPDATE OF "user_id", "name_key" ON "academy_students"
  FOR EACH ROW EXECUTE FUNCTION academy_students_set_name_key();

-- AFTER a rename: every academy row of that account follows. A learner has no
-- UPDATE policy on academy_students, hence SECURITY DEFINER. Once M3's partial
-- unique index exists, a clash raises 23505 here and aborts the rename; the
-- application pre-checks and classifies it (errors.profile.nameTakenInAcademy).
CREATE OR REPLACE FUNCTION users_sync_learner_name_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE "academy_students"
     SET "name_key" = atlas_name_key(NEW."name")
   WHERE "user_id" = NEW."id"
     AND "name_key" IS DISTINCT FROM atlas_name_key(NEW."name");
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION users_sync_learner_name_key() FROM PUBLIC;

DROP TRIGGER IF EXISTS users_learner_name_key_au ON "users";
CREATE TRIGGER users_learner_name_key_au
  AFTER UPDATE OF "name" ON "users"
  FOR EACH ROW
  WHEN (OLD."name" IS DISTINCT FROM NEW."name")
  EXECUTE FUNCTION users_sync_learner_name_key();

-- ---------------------------------------------------------------------------
-- 4. Boolean-only checks (subdomain_is_taken precedent). They answer one fact
--    and never say which tenant, row or person holds the name.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION organization_name_taken(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM "organizations" WHERE "name_key" = p_key);
$$;

CREATE OR REPLACE FUNCTION academy_name_taken(p_key text, p_exclude_academy_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academies"
     WHERE "name_key" = p_key
       AND (p_exclude_academy_id IS NULL OR "id" <> p_exclude_academy_id)
  );
$$;

-- Exempt rows never block anyone (the M3 index is partial on them too).
CREATE OR REPLACE FUNCTION academy_learner_name_taken(
  p_academy_id text,
  p_key text,
  p_exclude_user_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_students"
     WHERE "academy_id" = p_academy_id
       AND "name_key" = p_key
       AND NOT "name_unique_exempt"
       AND (p_exclude_user_id IS NULL OR "user_id" <> p_exclude_user_id)
  );
$$;

-- Admission check for an account the caller may not be able to read: keys on
-- the account's CURRENT name, takes the per-(academy, key) advisory lock for
-- the rest of the caller's transaction (the same lock string the application
-- uses for a profile rename: 'learner-name:' || academy || ':' || key), then
-- answers whether another non-exempt learner of that academy holds the key.
CREATE OR REPLACE FUNCTION academy_learner_admission_name_taken(
  p_academy_id text,
  p_user_id text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k text;
BEGIN
  SELECT atlas_name_key(u."name") INTO k FROM "users" u WHERE u."id" = p_user_id;
  IF k IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('learner-name:' || p_academy_id || ':' || k, 0));
  RETURN academy_learner_name_taken(p_academy_id, k, p_user_id);
END
$$;

REVOKE ALL ON FUNCTION organization_name_taken(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION academy_name_taken(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION academy_learner_name_taken(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION academy_learner_admission_name_taken(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION organization_name_taken(text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION academy_name_taken(text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION academy_learner_name_taken(text, text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION academy_learner_admission_name_taken(text, text) TO "atlas_app";

ANALYZE "organizations";
ANALYZE "academies";
ANALYZE "academy_students";
