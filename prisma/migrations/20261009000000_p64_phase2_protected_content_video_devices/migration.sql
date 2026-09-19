-- ============================================================================
-- P64 Phase 2 — Protected content, provider-hosted video, device policy
-- (master plan Phase 2 §F).
--
-- WHAT THIS MIGRATION IS FOR
--
-- Before it, a lesson's payload lived in `course_lessons.content_url`: a
-- durable, permanently valid address handed out in bulk by the curriculum
-- endpoint. Three separate problems followed from that one shape, and all
-- three are findings this phase has to close:
--
--   S1  The object itself was anonymously fetchable. Knowing the URL was
--       the whole authorization check.
--   S2  `course_lessons` is legitimately readable by anyone browsing a
--       PUBLISHED, PUBLIC course, so the payload inherited a public
--       audience from its container. No policy could fix that without
--       also hiding the lesson's title and ordering, which must stay
--       public.
--   S3  One curriculum response delivered every URL in the course at
--       once. Revoking an enrollment afterwards changed nothing.
--
-- The structural fix (AD-3) is to give the payload its OWN table with its
-- OWN audience: `lesson_contents` and `lesson_resources` have no public
-- policy of any kind, so the only way to a byte is through
-- `LessonContentService.getContent()`, which re-decides entitlement at the
-- moment the bytes are asked for and signs something short-lived.
--
-- SECTIONS
--   1.  Enum types
--   2.  media_assets: access / provider / processing / duration / course
--   3.  course_lessons: preview, drip, duration, completion rule, video
--   4.  lesson_progress + course_progress: playback evidence
--   5.  lesson_contents + lesson_resources (+ RLS)
--   6.  can_access_lesson() — the single shared entitlement predicate
--   7.  content_access_log (+ RLS)
--   8.  student_devices (+ RLS)
--   9.  access_policies (+ RLS, + platform seed row 2/1)
--   10. refresh_tokens.device_id
--   11. academies.content_protection
--   12. tenant_usage.video_storage_minutes
--   13. Backfill of existing lesson payloads into lesson_contents
--
-- REVERSIBILITY / SAFETY
--
-- Every column added here is nullable or carries a DEFAULT matching the
-- behaviour the existing rows ALREADY had (`access = 'public'`,
-- `provider = 'r2'`, `processing_status = 'ready'`, `is_preview = false`,
-- `completion_rule = 'manual'`). Nothing is dropped, and
-- `course_lessons.content_url` is deliberately LEFT IN PLACE and still
-- populated: the previous image must keep running against this schema
-- (Phase 2 §T), and the sections projection only stops emitting it behind
-- a flag. Deleting it belongs to a later phase, after the flag is global.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Enum types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "media_asset_access" AS ENUM ('public', 'protected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "media_asset_provider" AS ENUM ('r2', 'cloudflare_stream');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "media_processing_status" AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "lesson_completion_rule" AS ENUM ('manual', 'watched_ratio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "lesson_content_kind" AS ENUM ('text', 'video', 'file', 'external');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "content_access_result" AS ENUM ('granted', 'refused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "access_policy_scope" AS ENUM ('platform', 'plan', 'academy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 2. media_assets — where the bytes live and whether they are protected
--
-- The defaults are not a convenience: every asset that exists today IS a
-- public R2 object that finished processing long ago, so `public`/`r2`/
-- `ready` is a true statement about those rows, not a placeholder. That is
-- what makes this column addition safe to run while the previous image is
-- still serving traffic.
-- ---------------------------------------------------------------------------
ALTER TABLE "media_assets"
  ADD COLUMN IF NOT EXISTS "access" "media_asset_access" NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS "provider" "media_asset_provider" NOT NULL DEFAULT 'r2',
  ADD COLUMN IF NOT EXISTS "provider_id" TEXT,
  ADD COLUMN IF NOT EXISTS "processing_status" "media_processing_status" NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS "duration_seconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "course_id" TEXT;

-- The quota SUM (D5/AD-14) reads exactly these three columns for one
-- academy. Without the index it is a sequential scan of every asset on the
-- platform, on every single upload request.
CREATE INDEX IF NOT EXISTS "media_assets_academy_id_provider_processing_status_idx"
  ON "media_assets"("academy_id", "provider", "processing_status");

-- A provider id must be unique per provider — the webhook is idempotent BY
-- uid (Phase 2 §D.4), and idempotency that can match two rows is not
-- idempotency. Partial, because `r2` rows have no provider id at all.
CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_provider_provider_id_key"
  ON "media_assets"("provider", "provider_id")
  WHERE "provider_id" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "media_assets"
    ADD CONSTRAINT "media_assets_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 3. course_lessons — preview, drip, duration, completion rule, video
-- ---------------------------------------------------------------------------
ALTER TABLE "course_lessons"
  ADD COLUMN IF NOT EXISTS "is_preview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "available_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "duration_seconds" INTEGER,
  ADD COLUMN IF NOT EXISTS "completion_rule" "lesson_completion_rule" NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "video_asset_id" TEXT;

CREATE INDEX IF NOT EXISTS "course_lessons_video_asset_id_idx"
  ON "course_lessons"("video_asset_id");

DO $$ BEGIN
  ALTER TABLE "course_lessons"
    ADD CONSTRAINT "course_lessons_video_asset_id_fkey"
    FOREIGN KEY ("video_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 4. Playback evidence
--
-- `max_watched_ratio` is NUMERIC(5,4) — four decimal places, 0.0000 to
-- 1.0000. A ratio is not a percentage-with-two-places: the completion gate
-- compares it against a threshold, and rounding 0.7996 up to 0.80 to pass
-- an "80% watched" rule would be the database quietly deciding a
-- completion the evidence does not support.
-- ---------------------------------------------------------------------------
ALTER TABLE "lesson_progress"
  ADD COLUMN IF NOT EXISTS "last_position_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "watched_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_watched_ratio" DECIMAL(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);

ALTER TABLE "course_progress"
  ADD COLUMN IF NOT EXISTS "time_spent_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);


-- ---------------------------------------------------------------------------
-- 5. lesson_contents + lesson_resources
--
-- `academy_id` and `course_id` are denormalised onto both tables ON
-- PURPOSE. Phase 1 spent two corrective migrations (20261008000400,
-- 20261008000700) removing inline `EXISTS` subqueries from policies,
-- because such a subquery runs as the INVOKING role and therefore
-- evaluates every policy of the table it reaches into, once per candidate
-- row. A policy that can decide its tenant from its own row never has that
-- problem. These two columns are what make that possible here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lesson_contents" (
  "id"             TEXT NOT NULL,
  "lesson_id"      TEXT NOT NULL,
  "course_id"      TEXT NOT NULL,
  "academy_id"     TEXT NOT NULL,
  "kind"           "lesson_content_kind" NOT NULL,
  "body_html"      TEXT,
  "media_asset_id" TEXT,
  "external_url"   TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lesson_contents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_contents_lesson_id_key" ON "lesson_contents"("lesson_id");
CREATE INDEX IF NOT EXISTS "lesson_contents_academy_id_course_id_idx" ON "lesson_contents"("academy_id", "course_id");
CREATE INDEX IF NOT EXISTS "lesson_contents_media_asset_id_idx" ON "lesson_contents"("media_asset_id");

CREATE TABLE IF NOT EXISTS "lesson_resources" (
  "id"             TEXT NOT NULL,
  "lesson_id"      TEXT NOT NULL,
  "course_id"      TEXT NOT NULL,
  "academy_id"     TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "media_asset_id" TEXT,
  "external_url"   TEXT,
  "order"          INTEGER NOT NULL DEFAULT 0,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lesson_resources_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "lesson_resources_lesson_id_order_idx" ON "lesson_resources"("lesson_id", "order");
CREATE INDEX IF NOT EXISTS "lesson_resources_academy_id_course_id_idx" ON "lesson_resources"("academy_id", "course_id");
CREATE INDEX IF NOT EXISTS "lesson_resources_media_asset_id_idx" ON "lesson_resources"("media_asset_id");

DO $$ BEGIN
  ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_lesson_id_fkey"
    FOREIGN KEY ("lesson_id") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_contents" ADD CONSTRAINT "lesson_contents_media_asset_id_fkey"
    FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_lesson_id_fkey"
    FOREIGN KEY ("lesson_id") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lesson_resources" ADD CONSTRAINT "lesson_resources_media_asset_id_fkey"
    FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 6. can_access_lesson() — ONE predicate, shared by every policy below
--
-- SECURITY DEFINER for the reason Phase 1 established the hard way: this
-- question needs `enrollments`, `courses`, `course_lessons`,
-- `course_instructors` and `academy_members`, and asking them inline from a
-- policy would evaluate each of those tables' own policies once per
-- candidate row. The function answers with indexed lookups and evaluates
-- no policies at all.
--
-- It grants NO row visibility of its own: it returns a boolean about the
-- caller, keyed on the caller id the POLICY passes in from
-- `app.current_user_id`, never on anything a caller can put in a request.
--
-- The four ways in, in the order they are cheapest to disprove:
--
--   preview     a lesson explicitly marked `is_preview` on a published
--               course, open to anyone including anonymous visitors — this
--               is the sample a prospective student watches, and it is the
--               ONE place the chain is meant to short-circuit.
--   enrolled    an active, unrevoked, unexpired enrollment on a published
--               course, for a published lesson whose drip date has passed.
--   instructor  assigned to the course.
--   manager     owner/administrator/manager of the owning academy.
--
-- What is deliberately NOT here: the device lease, the session binding and
-- the rate limit. Those are properties of a REQUEST, not of a row, and a
-- row-security predicate that changed its answer based on which browser
-- asked would make every staff query non-deterministic. The service layer
-- (`LessonContentService`) checks all seven conditions; RLS independently
-- agrees about the four that are row-shaped. Guard decides, RLS agrees.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_access_lesson(p_lesson_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- preview on a published course — no identity required
    SELECT 1
    FROM "course_lessons" l
    JOIN "courses" c ON c."id" = l."course_id"
    WHERE l."id" = p_lesson_id
      AND l."is_preview" = true
      AND l."status" = 'published'
      AND c."status" = 'published'
  )
  OR (
    p_user_id IS NOT NULL AND p_user_id <> ''
    AND (
      EXISTS (
        -- Active enrollment, published course, deliverable lesson.
        --
        -- `status IN ('enrolled','completed')` is `ACTIVE_ENROLLMENT_STATUSES`
        -- verbatim, and the three extra conditions are `isEnrollmentActive()`
        -- verbatim. The academy-membership check is
        -- `assertActiveEnrollment`'s condition 7: a blocked student loses
        -- every course of that academy at once, and RLS has to agree with
        -- the guard about that rather than leaving it to the service.
        SELECT 1
        FROM "course_lessons" l
        JOIN "courses" c ON c."id" = l."course_id"
        JOIN "enrollments" e ON e."course_id" = l."course_id"
        WHERE l."id" = p_lesson_id
          AND l."status" = 'published'
          AND c."status" = 'published'
          AND e."student_id" = p_user_id
          AND e."status" IN ('enrolled', 'completed')
          AND e."revoked_at" IS NULL
          AND (e."expires_at" IS NULL OR e."expires_at" > now())
          AND (l."available_at" IS NULL OR l."available_at" <= now())
          AND is_academy_student(c."academy_id", p_user_id)
      )
      OR EXISTS (
        -- course instructor
        SELECT 1
        FROM "course_lessons" l
        JOIN "course_instructors" ci ON ci."course_id" = l."course_id"
        WHERE l."id" = p_lesson_id
          AND ci."user_id" = p_user_id
      )
      OR EXISTS (
        -- academy owner / administrator / manager
        SELECT 1
        FROM "course_lessons" l
        JOIN "courses" c ON c."id" = l."course_id"
        JOIN "academy_members" am ON am."academy_id" = c."academy_id"
        WHERE l."id" = p_lesson_id
          AND am."user_id" = p_user_id
          AND am."status" = 'active'
          AND am."role" IN ('owner', 'administrator', 'manager')
      )
    )
  );
$$;


-- ---------------------------------------------------------------------------
-- 5b. RLS for lesson_contents / lesson_resources
--
-- THERE IS NO PUBLIC POLICY HERE, AND THAT IS THE POINT (AD-3). Compare
-- `course_lessons`, which has a public-discovery tier so a marketing page
-- can list a curriculum: this table deliberately has no equivalent, so a
-- published, public course's BODY is still unreadable without one of the
-- four ways in above.
--
-- Writes are staff-only and tenant-scoped: a learner can read a row this
-- way, never create or change one.
-- ---------------------------------------------------------------------------
ALTER TABLE "lesson_contents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lesson_contents" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "lesson_contents" TO atlas_app;

ALTER TABLE "lesson_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lesson_resources" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "lesson_resources" TO atlas_app;

DROP POLICY IF EXISTS "lesson_contents_access_select" ON "lesson_contents";
CREATE POLICY "lesson_contents_access_select" ON "lesson_contents"
  FOR SELECT
  USING (can_access_lesson("lesson_contents"."lesson_id", current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "lesson_contents_platform_select" ON "lesson_contents";
CREATE POLICY "lesson_contents_platform_select" ON "lesson_contents"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "lesson_contents_tenant_write" ON "lesson_contents";
CREATE POLICY "lesson_contents_tenant_write" ON "lesson_contents"
  FOR ALL
  USING (
    "lesson_contents"."academy_id" IN (
      SELECT a."id" FROM "academies" a
      WHERE a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    "lesson_contents"."academy_id" IN (
      SELECT a."id" FROM "academies" a
      WHERE a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

DROP POLICY IF EXISTS "lesson_resources_access_select" ON "lesson_resources";
CREATE POLICY "lesson_resources_access_select" ON "lesson_resources"
  FOR SELECT
  USING (can_access_lesson("lesson_resources"."lesson_id", current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "lesson_resources_platform_select" ON "lesson_resources";
CREATE POLICY "lesson_resources_platform_select" ON "lesson_resources"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "lesson_resources_tenant_write" ON "lesson_resources";
CREATE POLICY "lesson_resources_tenant_write" ON "lesson_resources"
  FOR ALL
  USING (
    "lesson_resources"."academy_id" IN (
      SELECT a."id" FROM "academies" a
      WHERE a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    "lesson_resources"."academy_id" IN (
      SELECT a."id" FROM "academies" a
      WHERE a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );


-- ---------------------------------------------------------------------------
-- 7. content_access_log
--
-- Self-readable (a learner may see their own access history), manager- and
-- platform-readable. INSERT is deliberately unrestricted-by-tenant in one
-- narrow way: the row's `user_id` must match the acting user OR the insert
-- must come from a tenant context, because a REFUSAL is recorded for
-- people who turned out not to be entitled — including anonymous ones —
-- and a policy that only let entitled users write would silently drop
-- exactly the rows the security review needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "content_access_log" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT,
  "academy_id" TEXT NOT NULL,
  "course_id"  TEXT NOT NULL,
  "lesson_id"  TEXT NOT NULL,
  "result"     "content_access_result" NOT NULL,
  "reason"     TEXT,
  "device_id"  TEXT,
  "session_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_access_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "content_access_log_academy_id_created_at_idx" ON "content_access_log"("academy_id", "created_at");
CREATE INDEX IF NOT EXISTS "content_access_log_user_id_created_at_idx" ON "content_access_log"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "content_access_log_created_at_idx" ON "content_access_log"("created_at");

DO $$ BEGIN
  ALTER TABLE "content_access_log" ADD CONSTRAINT "content_access_log_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "content_access_log" ADD CONSTRAINT "content_access_log_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "content_access_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "content_access_log" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON "content_access_log" TO atlas_app;

DROP POLICY IF EXISTS "content_access_log_self_select" ON "content_access_log";
CREATE POLICY "content_access_log_self_select" ON "content_access_log"
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND "content_access_log"."user_id" = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS "content_access_log_manager_select" ON "content_access_log";
CREATE POLICY "content_access_log_manager_select" ON "content_access_log"
  FOR SELECT
  USING (
    can_manage_academy_students(
      "content_access_log"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS "content_access_log_platform_select" ON "content_access_log";
CREATE POLICY "content_access_log_platform_select" ON "content_access_log"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS "content_access_log_insert" ON "content_access_log";
CREATE POLICY "content_access_log_insert" ON "content_access_log"
  FOR INSERT
  WITH CHECK (
    "content_access_log"."user_id" IS NULL
    OR "content_access_log"."user_id" = current_setting('app.current_user_id', true)
  );

-- Retention (Phase 2 §F: 90 days). A DELETE policy scoped to rows that are
-- actually past the window, so the sweep cannot be repurposed into a way to
-- erase yesterday's evidence.
DROP POLICY IF EXISTS "content_access_log_retention_delete" ON "content_access_log";
CREATE POLICY "content_access_log_retention_delete" ON "content_access_log"
  FOR DELETE
  USING ("content_access_log"."created_at" < now() - INTERVAL '90 days');


-- ---------------------------------------------------------------------------
-- 8. student_devices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "student_devices" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "academy_id"   TEXT NOT NULL,
  "cookie_hash"  TEXT NOT NULL,
  "label"        TEXT NOT NULL,
  "user_agent"   TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"   TIMESTAMP(3),
  CONSTRAINT "student_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "student_devices_cookie_hash_key" ON "student_devices"("cookie_hash");
CREATE INDEX IF NOT EXISTS "student_devices_user_id_academy_id_revoked_at_idx" ON "student_devices"("user_id", "academy_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "student_devices_academy_id_revoked_at_idx" ON "student_devices"("academy_id", "revoked_at");

DO $$ BEGIN
  ALTER TABLE "student_devices" ADD CONSTRAINT "student_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "student_devices" ADD CONSTRAINT "student_devices_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "student_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "student_devices" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON "student_devices" TO atlas_app;

DROP POLICY IF EXISTS "student_devices_self_all" ON "student_devices";
CREATE POLICY "student_devices_self_all" ON "student_devices"
  FOR ALL
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND "student_devices"."user_id" = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND "student_devices"."user_id" = current_setting('app.current_user_id', true)
  );

-- Owner reset (Phase 2 §D.7). SELECT + UPDATE only — staff may see and
-- revoke a learner's devices, never register one on their behalf.
DROP POLICY IF EXISTS "student_devices_manager_select" ON "student_devices";
CREATE POLICY "student_devices_manager_select" ON "student_devices"
  FOR SELECT
  USING (
    can_manage_academy_students(
      "student_devices"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS "student_devices_manager_update" ON "student_devices";
CREATE POLICY "student_devices_manager_update" ON "student_devices"
  FOR UPDATE
  USING (
    can_manage_academy_students(
      "student_devices"."academy_id",
      current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    can_manage_academy_students(
      "student_devices"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );


-- ---------------------------------------------------------------------------
-- 9. access_policies (+ the platform default row: 2 devices, 1 session)
--
-- The platform row is seeded here rather than in `seed.ts` because it is
-- not sample data: without it the resolver has no floor to fall back to,
-- and "no policy found" would have to mean either "unlimited" (wrong, and
-- silently disables D4) or "zero" (wrong, and locks every learner out).
-- Making it part of the schema change means the policy exists the instant
-- the code that reads it does.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "access_policies" (
  "id"                      TEXT NOT NULL,
  "scope"                   "access_policy_scope" NOT NULL,
  "academy_id"              TEXT,
  "plan_key"                TEXT,
  "max_devices"             INTEGER NOT NULL,
  "max_concurrent_sessions" INTEGER NOT NULL,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "access_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "access_policies_academy_id_key" ON "access_policies"("academy_id");
CREATE INDEX IF NOT EXISTS "access_policies_scope_idx" ON "access_policies"("scope");

DO $$ BEGIN
  ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A value below 1 would lock every learner out of their own account; a
-- scope/target mismatch would make the resolver's "most specific first"
-- ordering meaningless. Both are structural, so both are constraints.
DO $$ BEGIN
  ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_positive_limits_check"
    CHECK ("max_devices" >= 1 AND "max_concurrent_sessions" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_scope_target_check"
    CHECK (
      ("scope" = 'platform' AND "academy_id" IS NULL AND "plan_key" IS NULL)
      OR ("scope" = 'academy'  AND "academy_id" IS NOT NULL AND "plan_key" IS NULL)
      OR ("scope" = 'plan'     AND "academy_id" IS NULL AND "plan_key" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "access_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_policies" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "access_policies" TO atlas_app;

-- Everyone authenticated may READ the policy that governs them — the
-- learner's Devices page has to say "2 of 2 devices used", and it cannot
-- say that without knowing the 2. Only the ceiling is public; nothing
-- about another learner is.
DROP POLICY IF EXISTS "access_policies_read" ON "access_policies";
CREATE POLICY "access_policies_read" ON "access_policies"
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
  );

-- Writes: the academy row belongs to the Client Owner (D8, enforced by
-- role in the service); the platform row belongs to the platform owner.
DROP POLICY IF EXISTS "access_policies_academy_write" ON "access_policies";
CREATE POLICY "access_policies_academy_write" ON "access_policies"
  FOR ALL
  USING (
    "access_policies"."scope" = 'academy'
    AND "access_policies"."academy_id" IS NOT NULL
    AND can_manage_academy_students(
      "access_policies"."academy_id",
      current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    "access_policies"."scope" = 'academy'
    AND "access_policies"."academy_id" IS NOT NULL
    AND can_manage_academy_students(
      "access_policies"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS "access_policies_platform_write" ON "access_policies";
CREATE POLICY "access_policies_platform_write" ON "access_policies"
  FOR ALL
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

INSERT INTO "access_policies" ("id", "scope", "max_devices", "max_concurrent_sessions", "created_at", "updated_at")
SELECT 'p64-platform-access-policy', 'platform', 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "access_policies" WHERE "scope" = 'platform');


-- ---------------------------------------------------------------------------
-- 10. refresh_tokens.device_id
-- ---------------------------------------------------------------------------
ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "device_id" TEXT;

CREATE INDEX IF NOT EXISTS "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

DO $$ BEGIN
  ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "student_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------------
-- 11. academies.content_protection (D8 — owner only, enforced in service)
-- ---------------------------------------------------------------------------
ALTER TABLE "academies"
  ADD COLUMN IF NOT EXISTS "content_protection" JSONB;


-- ---------------------------------------------------------------------------
-- 12. tenant_usage.video_storage_minutes (D5 / AD-14)
--
-- A NEW column, not a reinterpretation of `video_storage_gb`. They measure
-- different resources: gigabytes of video sitting in Atlas's own R2 versus
-- minutes of video hosted by the streaming provider. An academy can be at
-- zero on one and at its ceiling on the other.
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_usage"
  ADD COLUMN IF NOT EXISTS "video_storage_minutes" INTEGER NOT NULL DEFAULT 0;


-- ---------------------------------------------------------------------------
-- 13. Backfill — existing lesson payloads become lesson_contents rows
--
-- Idempotent (`WHERE NOT EXISTS`), so a re-run is a no-op, and it reads
-- only rows that actually have a payload.
--
-- Classification, and why `external` is the honest default for a URL:
--
--   text lessons   → their `description` becomes `body_html`. The old
--                    shape had nowhere else to put a text lesson's body,
--                    so `description` IS the body for these rows; moving
--                    it is a relocation, not an invention.
--   video / file   → the `content_url` is a URL Atlas did not necessarily
--                    mint and CANNOT retroactively prove is a protected
--                    object it owns. Marking it `external` says exactly
--                    that: it is delivered, and the learner is told it is
--                    not protected. Claiming `kind: video` + protection
--                    for a URL that is still anonymously fetchable would
--                    be a lie told by a migration.
--
-- The protected-bucket copy that turns these into real protected assets is
-- the per-academy backfill in Phase 2 §F, run under the `content.protected`
-- flag once a bucket exists for that academy — deliberately NOT here, where
-- it would have to move every academy's bytes in one transaction.
--
-- `content_url` is left populated. The previous image still reads it.
-- ---------------------------------------------------------------------------
INSERT INTO "lesson_contents" ("id", "lesson_id", "course_id", "academy_id", "kind", "body_html", "external_url", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  l."id",
  l."course_id",
  c."academy_id",
  CASE WHEN l."content_type" = 'text' THEN 'text'::"lesson_content_kind"
       ELSE 'external'::"lesson_content_kind" END,
  CASE WHEN l."content_type" = 'text' THEN l."description" ELSE NULL END,
  CASE WHEN l."content_type" = 'text' THEN NULL ELSE l."content_url" END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "course_lessons" l
JOIN "courses" c ON c."id" = l."course_id"
WHERE (
    (l."content_type" = 'text' AND l."description" IS NOT NULL AND l."description" <> '')
    OR (l."content_type" <> 'text' AND l."content_url" IS NOT NULL AND l."content_url" <> '')
  )
  AND NOT EXISTS (SELECT 1 FROM "lesson_contents" lc WHERE lc."lesson_id" = l."id");


-- ---------------------------------------------------------------------------
-- 14. Plan catalog — `videoStorageMinutes` (D5, mapped per DL-3)
--
-- `plans.limits` is JSONB validated server-side rather than
-- schema-enforced (the established precedent on this model), so adding a
-- limit KEY is a data change, not a column. Every plan gets a value here
-- because `VideoQuotaService` treats a missing one as ZERO — fail closed,
-- so a plan nobody has given a video allowance cannot silently receive an
-- unlimited one.
--
-- The three catalog tiers take the approved mapping:
--   starter → 500, growth → 2,000, enterprise → 5,000.
-- ("Professional" and "Business" in D5's wording are this repository's
--  `growth` and `enterprise`; DL-3 records the mapping.)
--
-- Every OTHER row — test fixtures, per-organization custom plans, legacy
-- rows — receives the Starter allowance of 500. That is a deliberate
-- floor, not a guess at what each was worth: it is the smallest real
-- allowance in the catalog, it keeps existing tenants working rather than
-- blocking them at zero, and an operator can raise any individual plan.
-- Rows that somehow already carry the key are left alone.
--
-- These are ATLAS entitlements. No provider price is stored or derived
-- from them anywhere (D5).
-- ---------------------------------------------------------------------------
UPDATE "plans"
SET "limits" = jsonb_set(
      "limits"::jsonb,
      '{videoStorageMinutes}',
      to_jsonb(
        CASE "key"
          WHEN 'starter'    THEN 500
          WHEN 'growth'     THEN 2000
          WHEN 'enterprise' THEN 5000
          ELSE 500
        END
      ),
      true
    )
WHERE NOT ("limits"::jsonb ? 'videoStorageMinutes');
