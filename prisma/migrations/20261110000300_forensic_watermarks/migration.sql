-- Forensic video watermark (docs/FORENSIC_WATERMARK.md).
--
-- WHAT THIS IS. Every video grant (hosted MP4, Cloudflare Stream, YouTube
-- embed), every free course preview and every live-class join now carries a
-- short code — ten Crockford base32 symbols, the last a mod-37 check — that
-- the player draws over the picture. This table records, per code, who was
-- watching what, on which session and device. When a screen recording leaks,
-- the Platform Owner reads the code off the recording and looks it up.
--
-- WHY NO FOREIGN KEYS. A leaked recording outlives the account that made it,
-- the academy that published it and the lesson it came from. Every id here is
-- a plain value and nothing cascades into this table: account deletion
-- (`AccountDeletionService`), an academy archive or a hard user delete leaves
-- the record intact. The identity at issue time (name, email, phone) is kept
-- as an AES-256-GCM snapshot (`identity_snapshot`, authenticated against the
-- code), never as plaintext. Retention: `WATERMARK_RETENTION_DAYS` (default
-- 730) after the code was last displayed, enforced by the maintenance sweep;
-- the delete policy below independently refuses anything seen in the last
-- 90 days.
--
-- WHO CAN READ IT. Only a Platform Owner (`is_platform_owner`). No academy,
-- organization or tenant policy exists, and adding one would be a deliberate,
-- reviewable migration.
--
-- WHO CAN WRITE IT. Nobody directly: there is no INSERT/UPDATE policy, so
-- `atlas_app` is refused every direct write. Writes go through three narrow
-- SECURITY DEFINER functions, each of which re-implements the self-only rule:
--
--   forensic_watermark_issue        — issue or reuse a code; the row's user
--                                     must be `app.current_user_id`, or, for
--                                     an anonymous COURSE PREVIEW only, there
--                                     must be no user context at all;
--   forensic_watermark_touch        — bump `last_seen_at` (throttled to once
--                                     a minute) on the caller's own rows for
--                                     one lesson in one session;
--   forensic_watermark_record_tamper — count one tamper report (throttled to
--                                     once per 30 s) on the caller's own row.
--
-- The functions return nothing but the caller's own code, so a learner can
-- never read another viewer's record — or even their own snapshot.
--
-- PURELY ADDITIVE. A new enum, table and functions; the previous release never
-- touches them.
--
-- REVERSE: DROP FUNCTION forensic_watermark_record_tamper(text, text);
--          DROP FUNCTION forensic_watermark_touch(text, text);
--          DROP FUNCTION forensic_watermark_issue(text, text, forensic_watermark_surface, text, text, text, text, text, text, text, text, text, timestamp(3), text, text, text, text, text);
--          DROP TABLE "forensic_watermarks";
--          DROP TYPE "forensic_watermark_surface";
--          (Destroys every forensic record; do not reverse in production.)

-- CreateEnum
CREATE TYPE "forensic_watermark_surface" AS ENUM ('lesson_video', 'course_preview', 'live_session');

-- CreateTable
CREATE TABLE "forensic_watermarks" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "session_key" VARCHAR(64) NOT NULL,
    "surface" "forensic_watermark_surface" NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "academy_id" TEXT NOT NULL,
    "course_id" TEXT,
    "lesson_id" TEXT,
    "live_session_id" TEXT,
    "session_id" TEXT,
    "device_id" TEXT,
    "device_cookie_hash" VARCHAR(64),
    "session_started_at" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_ip" VARCHAR(64),
    "country" VARCHAR(2),
    "user_agent" VARCHAR(512),
    "device_label" VARCHAR(120),
    "tamper_event_count" INTEGER NOT NULL DEFAULT 0,
    "last_tamper_at" TIMESTAMP(3),
    "identity_snapshot" TEXT,

    CONSTRAINT "forensic_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forensic_watermarks_code_key" ON "forensic_watermarks"("code");

-- CreateIndex
CREATE UNIQUE INDEX "forensic_watermarks_session_key_key" ON "forensic_watermarks"("session_key");

-- CreateIndex
CREATE INDEX "forensic_watermarks_user_id_issued_at_idx" ON "forensic_watermarks"("user_id", "issued_at");

-- CreateIndex
CREATE INDEX "forensic_watermarks_session_id_idx" ON "forensic_watermarks"("session_id");

-- CreateIndex
CREATE INDEX "forensic_watermarks_device_cookie_hash_idx" ON "forensic_watermarks"("device_cookie_hash");

-- CreateIndex
CREATE INDEX "forensic_watermarks_last_seen_at_idx" ON "forensic_watermarks"("last_seen_at");

-- Last line of defence for a writer that skips the application's checks.
-- The code alphabet is Crockford base32 (no I, L, O, U).
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_code_format"
  CHECK ("code" ~ '^[0-9A-HJKMNP-TV-Z]{10}$');
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_session_key_format"
  CHECK ("session_key" ~ '^[0-9a-f]{64}$');
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_country_format"
  CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_tamper_nonnegative"
  CHECK ("tamper_event_count" >= 0);
-- Every surface names what was shown, and only a course preview may be
-- anonymous.
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_target_shape"
  CHECK (
    ("surface" IN ('lesson_video', 'course_preview')
      AND "course_id" IS NOT NULL AND "lesson_id" IS NOT NULL)
    OR ("surface" = 'live_session' AND "live_session_id" IS NOT NULL)
  );
ALTER TABLE "forensic_watermarks"
  ADD CONSTRAINT "forensic_watermarks_anonymous_preview_only"
  CHECK ("user_id" IS NOT NULL OR "surface" = 'course_preview');

ALTER TABLE "forensic_watermarks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forensic_watermarks" FORCE ROW LEVEL SECURITY;

CREATE POLICY "forensic_watermarks_platform_select" ON "forensic_watermarks"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- Retention. The sweep runs as a Platform Owner (row visibility) and deletes
-- rows past `WATERMARK_RETENTION_DAYS`; this policy refuses any row displayed
-- in the last 90 days whatever cutoff the caller passes, so a misconfigured
-- or buggy sweep can never erase fresh evidence.
CREATE POLICY "forensic_watermarks_retention_delete" ON "forensic_watermarks"
  FOR DELETE USING (
    is_platform_owner(current_setting('app.current_user_id', true))
    AND "last_seen_at" < (now() AT TIME ZONE 'UTC') - interval '90 days'
  );

-- ---------------------------------------------------------------------------
-- Issue (or reuse) a code. Returns the code the caller must display, and
-- whether it was reused. Returns a NULL code when `p_code` collided with an
-- existing code (the application draws a new one and retries).
-- ---------------------------------------------------------------------------
CREATE FUNCTION forensic_watermark_issue(
  p_code text,
  p_session_key text,
  p_surface forensic_watermark_surface,
  p_user_id text,
  p_organization_id text,
  p_academy_id text,
  p_course_id text,
  p_lesson_id text,
  p_live_session_id text,
  p_session_id text,
  p_device_id text,
  p_device_cookie_hash text,
  p_session_started_at timestamp(3),
  p_client_ip text,
  p_country text,
  p_user_agent text,
  p_device_label text,
  p_identity_snapshot text
)
RETURNS TABLE (code text, reused boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.current_user_id', true), '');
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  v_code text;
BEGIN
  -- The self-only rule the missing INSERT policy would otherwise state.
  IF p_user_id IS NULL THEN
    IF v_actor IS NOT NULL OR p_surface <> 'course_preview' THEN
      RAISE EXCEPTION 'forensic_watermark_issue: an anonymous code is only issued for a course preview with no user context'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'forensic_watermark_issue: a code is only issued to the signed-in viewer themself'
      USING ERRCODE = '42501';
  END IF;

  -- Same session, same target: the code already on screen stays on screen.
  UPDATE "forensic_watermarks" AS w
     SET "last_seen_at" = v_now
   WHERE w."session_key" = p_session_key
     AND w."user_id" IS NOT DISTINCT FROM p_user_id
  RETURNING w."code" INTO v_code;
  IF v_code IS NOT NULL THEN
    RETURN QUERY SELECT v_code, true;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO "forensic_watermarks" (
      "id", "code", "session_key", "surface", "user_id", "organization_id",
      "academy_id", "course_id", "lesson_id", "live_session_id", "session_id",
      "device_id", "device_cookie_hash", "session_started_at", "issued_at",
      "last_seen_at", "client_ip", "country", "user_agent", "device_label",
      "identity_snapshot"
    ) VALUES (
      gen_random_uuid()::text, p_code, p_session_key, p_surface, p_user_id,
      p_organization_id, p_academy_id, p_course_id, p_lesson_id,
      p_live_session_id, p_session_id, p_device_id, p_device_cookie_hash,
      p_session_started_at, v_now, v_now, left(p_client_ip, 64),
      p_country, left(p_user_agent, 512), left(p_device_label, 120),
      p_identity_snapshot
    )
    ON CONFLICT ("session_key") DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    -- Only `code` can collide here (`session_key` is handled above): tell
    -- the caller to draw again.
    RETURN QUERY SELECT NULL::text, false;
    RETURN;
  END;

  -- Either our row, or the one a concurrent identical request just wrote.
  SELECT w."code" INTO v_code
    FROM "forensic_watermarks" AS w
   WHERE w."session_key" = p_session_key
     AND w."user_id" IS NOT DISTINCT FROM p_user_id;
  RETURN QUERY SELECT v_code, (v_code IS DISTINCT FROM p_code);
END;
$$;

-- ---------------------------------------------------------------------------
-- The playback heartbeat's "still on screen" — at most one write a minute.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forensic_watermark_touch(p_session_id text, p_lesson_id text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.current_user_id', true), '');
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  touched integer;
BEGIN
  IF v_actor IS NULL OR p_session_id IS NULL OR p_lesson_id IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE "forensic_watermarks"
     SET "last_seen_at" = v_now
   WHERE "session_id" = p_session_id
     AND "lesson_id" = p_lesson_id
     AND "user_id" = v_actor
     AND "last_seen_at" < v_now - interval '60 seconds';
  GET DIAGNOSTICS touched = ROW_COUNT;
  RETURN touched;
END;
$$;

-- ---------------------------------------------------------------------------
-- One tamper report from the player's watchdog. Counted only on the caller's
-- own row (or, for an anonymous preview, the row its own device cookie
-- opened), and at most once per 30 seconds, so the count cannot be inflated
-- against somebody else's code or by a loop.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forensic_watermark_record_tamper(p_code text, p_device_cookie_hash text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor text := NULLIF(current_setting('app.current_user_id', true), '');
  v_now timestamp(3) := (now() AT TIME ZONE 'UTC');
  counted integer;
BEGIN
  UPDATE "forensic_watermarks"
     SET "tamper_event_count" = "tamper_event_count" + 1,
         "last_tamper_at" = v_now
   WHERE "code" = p_code
     AND (
       (v_actor IS NOT NULL AND "user_id" = v_actor)
       OR (v_actor IS NULL AND "user_id" IS NULL
           AND p_device_cookie_hash IS NOT NULL
           AND "device_cookie_hash" = p_device_cookie_hash)
     )
     AND ("last_tamper_at" IS NULL OR "last_tamper_at" < v_now - interval '30 seconds');
  GET DIAGNOSTICS counted = ROW_COUNT;
  RETURN counted;
END;
$$;

REVOKE ALL ON FUNCTION forensic_watermark_issue(text, text, forensic_watermark_surface, text, text, text, text, text, text, text, text, text, timestamp(3), text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forensic_watermark_touch(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forensic_watermark_record_tamper(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forensic_watermark_issue(text, text, forensic_watermark_surface, text, text, text, text, text, text, text, text, text, timestamp(3), text, text, text, text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION forensic_watermark_touch(text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION forensic_watermark_record_tamper(text, text) TO "atlas_app";
