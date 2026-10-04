-- ============================================================================
-- W4 (M3 of 3) — the unique indexes.
--
--   organizations_name_key_key                  — one organization per key,
--                                                 platform-wide, every status
--   academies_name_key_key                      — one academy per key,
--                                                 platform-wide, archived
--                                                 included (like slugs)
--   academy_students_academy_id_name_key_key    — one NON-EXEMPT learner per
--                                                 key per academy (partial:
--                                                 Prisma cannot express it;
--                                                 documented on the model)
--
-- The indexes are the final truth for every write path, scripts and seeds
-- included; the application pre-checks under an advisory lock only to give a
-- precise 409 (see src/common/name-uniqueness).
--
-- Plain CREATE UNIQUE INDEX inside the migration transaction: these tables
-- are small (prod tens of rows; local ~1.4k), so the SHARE lock lasts
-- milliseconds and a failure leaves no INVALID index behind (unlike
-- CONCURRENTLY). Writers are locked out from the duplicate check to the end
-- of the build, so the check cannot go stale.
--
-- Reversal: DROP INDEX organizations_name_key_key, academies_name_key_key,
-- academy_students_academy_id_name_key_key;
-- ============================================================================

SET LOCAL lock_timeout = '10s';

LOCK TABLE "organizations", "academies", "academy_students" IN SHARE MODE;

DO $$
DECLARE
  v_orgs integer;
  v_acads integer;
  v_learners integer;
BEGIN
  SELECT count(*) INTO v_orgs
    FROM (SELECT 1 FROM "organizations" GROUP BY "name_key" HAVING count(*) > 1) g;
  SELECT count(*) INTO v_acads
    FROM (SELECT 1 FROM "academies" GROUP BY "name_key" HAVING count(*) > 1) g;
  SELECT count(*) INTO v_learners
    FROM (SELECT 1 FROM "academy_students" WHERE NOT "name_unique_exempt"
           GROUP BY "academy_id", "name_key" HAVING count(*) > 1) g;
  IF v_orgs + v_acads + v_learners > 0 THEN
    RAISE EXCEPTION
      'w4_name_unique_indexes: duplicate names remain (organization groups %, academy groups %, learner groups %). Run the W4 remediation (docs/W4_UNIQUENESS_REMEDIATION.md) first.',
      v_orgs, v_acads, v_learners;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_name_key_key"
  ON "organizations" ("name_key");
CREATE UNIQUE INDEX IF NOT EXISTS "academies_name_key_key"
  ON "academies" ("name_key");
CREATE UNIQUE INDEX IF NOT EXISTS "academy_students_academy_id_name_key_key"
  ON "academy_students" ("academy_id", "name_key")
  WHERE NOT "name_unique_exempt";
