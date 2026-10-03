-- =============================================================================
-- W3 (Atlas Large-Scale Initiative) — `security_events`: the Platform Owner's
-- OTP & Security Monitoring record.
--
-- WHY A TABLE OF ITS OWN. The audit log cannot hold these: its
-- `actor_user_id` is a NOT NULL foreign key (so a pre-auth event for an
-- unknown address cannot be written), its org is derived from the academy
-- (so tenant owners can read learners' OTP rows), and it carried the raw
-- client IP. Rate-limit hits were not persisted anywhere.
--
-- WHAT A ROW HOLDS — and what it never holds:
--   * `event_type`, `surface` (management | academy), optional `academy_id`,
--     `challenge_id`, a closed-vocabulary `reason`, `attempts_remaining`;
--   * `user_id` ONLY when the account is known and the caller has already
--     proven the password (OTP issue/verify) or holds a session (deletion);
--   * `subject_hash` = HMAC-SHA256(server-derived key, normalised email),
--     hex — never the email itself;
--   * `ip_hash` = HMAC-SHA256(monthly key derived from a server secret, ip),
--     hex — correlatable within a month, never reversible, never the IP;
--   * NEVER a code, a code hash, a token, a password or a raw address.
--
-- FLOODS. Rate-limited events are folded into one row per
-- (event type, ip hash, subject hash, minute) with an `occurrences` count,
-- through `record_security_event_bucket` below, so a flood is one row per
-- minute rather than one per request.
--
-- RLS (FORCE):
--   * INSERT: system writes from any context (`WITH CHECK (true)`), the
--     `communication_outbox_system_insert` / `audit_log_entries` precedent —
--     the writer is always a trusted server-side effect, often pre-auth.
--   * SELECT: Platform Owner only (`is_platform_owner`). Pre-auth events are
--     therefore visible to nobody else; there is no tenant policy at all.
--   * DELETE: retention only — rows older than 90 days, run daily by the
--     security-maintenance sweep as a platform owner.
--   * No UPDATE policy: rows are immutable except the bucket counter, which
--     only the SECURITY DEFINER function below can bump.
--
-- Additive. Rollback: DROP FUNCTION record_security_event_bucket(...);
-- DROP TABLE "security_events"; DROP TYPE "security_event_type".
-- =============================================================================

CREATE TYPE "security_event_type" AS ENUM (
  'otp_sent',
  'otp_resent',
  'otp_verified',
  'otp_failed',
  'otp_expired',
  'otp_locked',
  'otp_rate_limited',
  'otp_suppressed',
  'deletion_code_sent',
  'deletion_code_verified',
  'deletion_code_failed',
  'deletion_code_locked',
  'deletion_code_rate_limited',
  'signin_rate_limited'
);

CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "event_type" "security_event_type" NOT NULL,
    "surface" VARCHAR(16),
    "user_id" TEXT,
    "subject_hash" VARCHAR(64),
    "ip_hash" VARCHAR(64),
    "academy_id" TEXT,
    "challenge_id" TEXT,
    "reason" VARCHAR(64),
    "attempts_remaining" SMALLINT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "bucket_key" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "security_events_bucket_key_key" ON "security_events"("bucket_key");
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at" DESC);
CREATE INDEX "security_events_event_type_created_at_idx" ON "security_events"("event_type", "created_at" DESC);
CREATE INDEX "security_events_academy_id_created_at_idx" ON "security_events"("academy_id", "created_at" DESC);
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at" DESC);
CREATE INDEX "security_events_ip_hash_created_at_idx" ON "security_events"("ip_hash", "created_at" DESC);
CREATE INDEX "security_events_subject_hash_created_at_idx" ON "security_events"("subject_hash", "created_at" DESC);

ALTER TABLE "security_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "security_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY "security_events_system_insert" ON "security_events"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "security_events_platform_select" ON "security_events"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "security_events_retention_delete" ON "security_events"
  FOR DELETE USING ("created_at" < now() - INTERVAL '90 days');

-- One row per (type, ip hash, subject hash, minute) for flood events. The
-- caller computes `p_bucket_key`; the function only upserts. SECURITY
-- DEFINER because `ON CONFLICT DO UPDATE` would otherwise need UPDATE and
-- SELECT policies that would expose bucket rows to every context.
CREATE OR REPLACE FUNCTION record_security_event_bucket(
  p_id text,
  p_event_type "security_event_type",
  p_surface text,
  p_subject_hash text,
  p_ip_hash text,
  p_reason text,
  p_bucket_key text
) RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO "security_events"
    ("id", "event_type", "surface", "subject_hash", "ip_hash", "reason", "bucket_key", "occurrences", "created_at")
  VALUES
    (p_id, p_event_type, left(p_surface, 16), left(p_subject_hash, 64), left(p_ip_hash, 64),
     left(p_reason, 64), left(p_bucket_key, 200), 1, CURRENT_TIMESTAMP)
  ON CONFLICT ("bucket_key") DO UPDATE
    SET "occurrences" = "security_events"."occurrences" + 1;
$$;

REVOKE ALL ON FUNCTION record_security_event_bucket(text, "security_event_type", text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_security_event_bucket(text, "security_event_type", text, text, text, text, text) TO "atlas_app";
