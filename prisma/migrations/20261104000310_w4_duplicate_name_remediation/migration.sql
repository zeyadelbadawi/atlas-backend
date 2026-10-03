-- ============================================================================
-- W4 (M2 of 3) — gated cleanup of existing duplicate names, before M3 makes
-- them unique. Runbook, report query and recovery SQL:
-- docs/W4_UNIQUENESS_REMEDIATION.md.
--
-- WHAT IT DOES (one transaction; all or nothing)
--   * Organizations and academies (both unique platform-wide, every status):
--     inside each group of rows that share `name_key`, the OLDEST row by
--     (created_at, id) keeps its name. Every later row is renamed to
--     "<name> (2)", "<name> (3)", … in that fixed order; if the suffixed name
--     is itself taken (e.g. a real "Acme (2)" exists) the number keeps going
--     until the key is free. The base is cut so the result fits the API limit
--     (organizations 120, academies 100 characters).
--   * Only `name` changes. Ids and slugs never change, so every foreign key,
--     subdomain and URL is preserved.
--   * Learners are NEVER renamed (a learner's name is their global account
--     name). Later rows of a duplicate group inside one academy are marked
--     `name_unique_exempt = true` instead.
--   * Every changed row is first copied into a `w4_backup_*` table with the
--     run timestamp, the old value and the new value — that IS the mapping
--     (no SQL-level audit writer exists in this codebase: audit rows need an
--     acting user, so the backup tables are the record).
--
-- THE GATE
--   Renaming customer-visible names needs a human decision. Per the product
--   owner's decision (3 Oct 2026), that decision is the protected
--   `production-migrations` environment approval, given after the read-only
--   duplicate report (`Release verify` -> "W4 duplicate-name report", counts
--   only) has been reviewed. On 3 Oct 2026 production held 18 organization
--   and 4 academy rows to rename (and 104 learner rows to exempt) out of 60
--   organizations / 35 academies.
--   A database-setting opt-in was replaced: a RAISE here leaves a failed
--   migration row that deploy.sh refuses on every later deploy.
--   Backstop against an unexpected mass rename: the migration RAISES, before
--   changing anything, if more than 100 organization or 100 academy rows
--   would be renamed. With no duplicates (a fresh database, CI) it is a
--   no-op. Learner exemptions change nothing anyone sees.
--
-- RECOVERY: docs/W4_UNIQUENESS_REMEDIATION.md §4 (restores names and flags
-- from the backup tables; only rows still holding the value written here).
-- ============================================================================

SET LOCAL lock_timeout = '10s';

-- Writers wait while the groups are computed and renamed (milliseconds).
LOCK TABLE "organizations", "academies", "academy_students" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS "w4_backup_organization_names" (
  "id"         text        NOT NULL,
  "name"       text        NOT NULL,
  "new_name"   text        NOT NULL,
  "name_key"   text        NOT NULL,
  "group_rank" integer     NOT NULL,
  "run_at"     timestamptz NOT NULL,
  PRIMARY KEY ("id", "run_at")
);
CREATE TABLE IF NOT EXISTS "w4_backup_academy_names" (
  "id"         text        NOT NULL,
  "name"       text        NOT NULL,
  "new_name"   text        NOT NULL,
  "name_key"   text        NOT NULL,
  "group_rank" integer     NOT NULL,
  "run_at"     timestamptz NOT NULL,
  PRIMARY KEY ("id", "run_at")
);
CREATE TABLE IF NOT EXISTS "w4_backup_academy_student_exemptions" (
  "id"                 text        NOT NULL,
  "academy_id"         text        NOT NULL,
  "user_id"            text        NOT NULL,
  "name_key"           text        NOT NULL,
  "previous_exempt"    boolean     NOT NULL,
  "run_at"             timestamptz NOT NULL,
  PRIMARY KEY ("id", "run_at")
);

-- Operator-only records: never readable by the application role (default
-- privileges would otherwise grant it), and FORCE RLS with no policy.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'w4_backup_organization_names',
    'w4_backup_academy_names',
    'w4_backup_academy_student_exemptions'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atlas_app') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM "atlas_app"', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

DO $$
DECLARE
  v_run_at     timestamptz := clock_timestamp();
  v_org_dups   integer;
  v_acad_dups  integer;
  r            record;
  n            integer;
  suffix       text;
  candidate    text;
  v_renamed    integer := 0;
  v_exempted   integer := 0;
BEGIN
  SELECT coalesce(sum(c - 1), 0) INTO v_org_dups
    FROM (SELECT count(*) c FROM "organizations" GROUP BY "name_key" HAVING count(*) > 1) g;
  SELECT coalesce(sum(c - 1), 0) INTO v_acad_dups
    FROM (SELECT count(*) c FROM "academies" GROUP BY "name_key" HAVING count(*) > 1) g;

  IF v_org_dups > 100 OR v_acad_dups > 100 THEN
    RAISE EXCEPTION
      'w4_duplicate_name_remediation: % organization(s) and % academy(ies) would be renamed, above the 100-row backstop. Review the report (docs/W4_UNIQUENESS_REMEDIATION.md §2) before raising it.',
      v_org_dups, v_acad_dups;
  END IF;

  -- Organizations ------------------------------------------------------------
  FOR r IN
    SELECT o."id", o."name", o."name_key", g.rn
      FROM "organizations" o
      JOIN (
        SELECT "id", row_number() OVER (PARTITION BY "name_key" ORDER BY "created_at", "id") rn
          FROM "organizations"
         WHERE "name_key" IN (
           SELECT "name_key" FROM "organizations" GROUP BY "name_key" HAVING count(*) > 1)
      ) g ON g."id" = o."id"
     WHERE g.rn > 1
     ORDER BY o."name_key", g.rn
  LOOP
    n := r.rn;
    LOOP
      suffix := ' (' || n || ')';
      candidate := left(rtrim(r."name"), 120 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "organizations" WHERE "name_key" = atlas_name_key(candidate));
      n := n + 1;
    END LOOP;
    INSERT INTO "w4_backup_organization_names"
      ("id", "name", "new_name", "name_key", "group_rank", "run_at")
      VALUES (r."id", r."name", candidate, r."name_key", r.rn, v_run_at);
    UPDATE "organizations" SET "name" = candidate WHERE "id" = r."id";
    v_renamed := v_renamed + 1;
  END LOOP;

  -- Academies (all statuses, archived included) ------------------------------
  FOR r IN
    SELECT a."id", a."name", a."name_key", g.rn
      FROM "academies" a
      JOIN (
        SELECT "id", row_number() OVER (PARTITION BY "name_key" ORDER BY "created_at", "id") rn
          FROM "academies"
         WHERE "name_key" IN (
           SELECT "name_key" FROM "academies" GROUP BY "name_key" HAVING count(*) > 1)
      ) g ON g."id" = a."id"
     WHERE g.rn > 1
     ORDER BY a."name_key", g.rn
  LOOP
    n := r.rn;
    LOOP
      suffix := ' (' || n || ')';
      candidate := left(rtrim(r."name"), 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "academies" WHERE "name_key" = atlas_name_key(candidate));
      n := n + 1;
    END LOOP;
    INSERT INTO "w4_backup_academy_names"
      ("id", "name", "new_name", "name_key", "group_rank", "run_at")
      VALUES (r."id", r."name", candidate, r."name_key", r.rn, v_run_at);
    UPDATE "academies" SET "name" = candidate WHERE "id" = r."id";
    v_renamed := v_renamed + 1;
  END LOOP;

  -- Learners: never renamed, later rows exempted ------------------------------
  WITH ranked AS (
    SELECT "id", "academy_id", "user_id", "name_key",
           row_number() OVER (PARTITION BY "academy_id", "name_key" ORDER BY "joined_at", "id") rn
      FROM "academy_students"
     WHERE NOT "name_unique_exempt"
  ), backed AS (
    INSERT INTO "w4_backup_academy_student_exemptions"
      ("id", "academy_id", "user_id", "name_key", "previous_exempt", "run_at")
    SELECT "id", "academy_id", "user_id", "name_key", false, v_run_at
      FROM ranked WHERE rn > 1
    RETURNING "id"
  )
  UPDATE "academy_students" s SET "name_unique_exempt" = true
    FROM backed b WHERE b."id" = s."id";
  GET DIAGNOSTICS v_exempted = ROW_COUNT;

  -- Postcondition: nothing M3 would refuse may remain.
  IF EXISTS (SELECT 1 FROM "organizations" GROUP BY "name_key" HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM "academies" GROUP BY "name_key" HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM "academy_students" WHERE NOT "name_unique_exempt"
                 GROUP BY "academy_id", "name_key" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'w4_duplicate_name_remediation: duplicates remain after remediation';
  END IF;

  RAISE NOTICE 'w4_duplicate_name_remediation: run_at=%, renamed=%, learners exempted=%',
    v_run_at, v_renamed, v_exempted;
END
$$;
