-- W8B — trial ledger hardening: keyed-hash versioning, provenance, and a
-- narrow retention scrub for the forensic columns.
--
-- 1. `hash_version`. v1 rows hold SHA-256('atlas.trial.subject.v1:' ||
--    canonical) — a constant salt that is public in source, so anyone with
--    a dump and a candidate email list can test addresses against it. New
--    claims store HMAC-SHA256(server key, canonical) and are labelled 2, in
--    the SAME unique `subject_hash` column, so the one-row-per-subject race
--    guarantee is unchanged. Existing rows are labelled 1 by the default.
--    v1 rows are frozen (never inserted again) and stay checked by the
--    application on every claim and describe, because v1 rows of deleted
--    users can never be upgraded (no raw email exists to recompute from).
--
-- 2. `source`. Where the row came from: a live claim, the pre-ledger
--    backfill script, or an opportunistic v2 copy of a v1 row.
--
-- 3. `scrub_trial_redemption_forensics(retention_days)`. `ip_address` and
--    `user_agent` are personal data kept only as abuse signals (never read by
--    the eligibility decision). The application role has no UPDATE on this
--    table (append-only since P33), so the retention job clears them through
--    this SECURITY DEFINER function, which can do exactly one thing: null
--    those two columns on rows older than the retention window. It cannot
--    touch `subject_hash`, dates or links, and refuses windows under 30 days
--    so a bug cannot wipe fresh abuse signals.
--
-- REVERSE: DROP FUNCTION scrub_trial_redemption_forensics(integer);
--          ALTER TABLE "trial_redemptions" DROP COLUMN "source",
--          DROP COLUMN "hash_version";
--          (Rows written as v2 remain valid hashes but would no longer be
--          distinguishable; do not reverse once v2 claims exist.)

ALTER TABLE "trial_redemptions"
    ADD COLUMN "hash_version" SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'claim';

ALTER TABLE "trial_redemptions"
    ADD CONSTRAINT "trial_redemptions_hash_version_chk"
    CHECK ("hash_version" IN (1, 2));

ALTER TABLE "trial_redemptions"
    ADD CONSTRAINT "trial_redemptions_source_chk"
    CHECK ("source" IN ('claim', 'backfill', 'v1_upgrade'));

CREATE INDEX "trial_redemptions_redeemed_at_idx"
    ON "trial_redemptions"("redeemed_at");

CREATE OR REPLACE FUNCTION scrub_trial_redemption_forensics(p_retention_days integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  scrubbed integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 30 THEN
    RAISE EXCEPTION 'scrub_trial_redemption_forensics: retention must be at least 30 days (got %)', p_retention_days;
  END IF;

  UPDATE "trial_redemptions"
     SET "ip_address" = NULL,
         "user_agent" = NULL
   WHERE "redeemed_at" < (now() AT TIME ZONE 'UTC') - make_interval(days => p_retention_days)
     AND ("ip_address" IS NOT NULL OR "user_agent" IS NOT NULL);

  GET DIAGNOSTICS scrubbed = ROW_COUNT;
  RETURN scrubbed;
END;
$$;

REVOKE ALL ON FUNCTION scrub_trial_redemption_forensics(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scrub_trial_redemption_forensics(integer) TO "atlas_app";
