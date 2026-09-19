-- ============================================================================
-- P64 Phase 1 — Foundation, Identity Surfaces, Membership Integrity and RBAC
-- (docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md, Phase 1, section F).
--
-- Everything here is additive, deterministic and safe to retry. Backfills
-- are idempotent (`WHERE ... IS NULL` / `ON CONFLICT DO NOTHING`); the one
-- data rewrite (duplicate quiz attempt numbers) is verified before the
-- unique constraint is added and renumbers in `created_at` order only.
--
-- 1. enrollments — access lifecycle (expires_at, revoked_at, revoke_reason,
--    access_source, course_order_id) with backfill from the existing
--    `unavailable` status and from matching course orders.
-- 2. academy_students — provenance/roster columns; academies —
--    registration_policy (D3: existing rows default to `open`);
--    academy_invites — invitation tokens (hash only).
-- 3. refresh_tokens — session surface + academy (AD-5), backfilled by the
--    principal facts a session's user held at migration time.
-- 4. quiz_attempts — dedupe attempt numbers, then UNIQUE (quiz, student,
--    attempt_number) and a partial UNIQUE "one open attempt".
-- 5. RLS — `can_review_course` (course instructor OR academy owner/
--    administrator/manager); review SELECT policies on quiz_attempts,
--    assignment_submissions, lesson_progress, course_progress; grading
--    UPDATE policy on assignment_submissions replacing the instructor-only
--    one; author-tier SELECT on course_sections/course_lessons (the
--    draft-course authoring 500); tenant SELECT on quiz_attempts (owner
--    analytics); instructor course-scoped SELECT on academy_students
--    replacing the any-staff one; `is_academy_student` now requires an
--    active, unblocked membership; enrollments self-update guarded by a
--    trigger that keeps lifecycle/ownership columns immutable for the
--    student's own context.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. enrollments — access lifecycle
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "enrollment_revoke_reason" AS ENUM ('refund', 'manual', 'membership_ended', 'expired', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "enrollment_access_source" AS ENUM ('free', 'order', 'manual', 'seed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revoke_reason" "enrollment_revoke_reason",
  ADD COLUMN IF NOT EXISTS "access_source" "enrollment_access_source" NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "course_order_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "enrollments"
    ADD CONSTRAINT "enrollments_course_order_id_fkey"
    FOREIGN KEY ("course_order_id") REFERENCES "course_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "enrollments_course_order_id_idx" ON "enrollments"("course_order_id");

-- Backfill: a refund previously expressed itself only as status `unavailable`.
UPDATE "enrollments"
SET "revoked_at" = COALESCE("updated_at", "created_at"), "revoke_reason" = 'refund'
WHERE "status" = 'unavailable' AND "revoked_at" IS NULL;

-- Backfill: enrollments that were granted by a paid course order.
UPDATE "enrollments" e
SET "access_source" = 'order', "course_order_id" = o."id"
FROM "course_orders" o
WHERE o."student_id" = e."student_id"
  AND o."course_id" = e."course_id"
  AND o."status" IN ('paid', 'refunded')
  AND e."course_order_id" IS NULL;

-- ----------------------------------------------------------------------------
-- 2. academy_students provenance, academies.registration_policy, academy_invites
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "academy_student_source" AS ENUM ('self_signup', 'sign_in_join', 'staff_created', 'purchase', 'invite', 'backfill');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "academy_registration_policy" AS ENUM ('open', 'invite', 'approval');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "academy_students"
  ADD COLUMN IF NOT EXISTS "source" "academy_student_source" NOT NULL DEFAULT 'self_signup',
  ADD COLUMN IF NOT EXISTS "registered_via_host" TEXT,
  ADD COLUMN IF NOT EXISTS "blocked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "blocked_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "invited_by" TEXT,
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "academy_students_academy_id_last_activity_at_idx"
  ON "academy_students"("academy_id", "last_activity_at");

-- Backfill provenance: a student whose creation is recorded in the audit log
-- as a staff action was staff-created; everyone else self-registered.
UPDATE "academy_students" s
SET "source" = 'staff_created'
FROM "audit_log_entries" a
WHERE a."action" = 'academy.student.created'
  AND a."target_id" = s."user_id"
  AND s."source" = 'self_signup';

-- Backfill last activity from the latest progress/attempt the student has.
UPDATE "academy_students" s
SET "last_activity_at" = sub.last_seen
FROM (
  SELECT e."academy_id", e."student_id",
         GREATEST(MAX(e."updated_at"), MAX(cp."updated_at")) AS last_seen
  FROM "enrollments" e
  LEFT JOIN "course_progress" cp ON cp."enrollment_id" = e."id"
  GROUP BY e."academy_id", e."student_id"
) sub
WHERE sub."academy_id" = s."academy_id" AND sub."student_id" = s."user_id"
  AND s."last_activity_at" IS NULL;

-- D3: existing academies are open by default.
ALTER TABLE "academies"
  ADD COLUMN IF NOT EXISTS "registration_policy" "academy_registration_policy" NOT NULL DEFAULT 'open';

CREATE TABLE IF NOT EXISTS "academy_invites" (
  "id"          TEXT NOT NULL,
  "academy_id"  TEXT NOT NULL,
  "token_hash"  TEXT NOT NULL,
  "created_by"  TEXT NOT NULL,
  "email"       TEXT,
  "max_uses"    INTEGER NOT NULL DEFAULT 1,
  "used_count"  INTEGER NOT NULL DEFAULT 0,
  "expires_at"  TIMESTAMP(3) NOT NULL,
  "revoked_at"  TIMESTAMP(3),
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "academy_invites_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "academy_invites_token_hash_key" ON "academy_invites"("token_hash");
CREATE INDEX IF NOT EXISTS "academy_invites_academy_id_expires_at_idx" ON "academy_invites"("academy_id", "expires_at");
DO $$ BEGIN
  ALTER TABLE "academy_invites"
    ADD CONSTRAINT "academy_invites_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "academy_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_invites" FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "academy_invites" TO atlas_app;

-- Staff of the owning organization manage invites (owner/administrator/
-- manager role check happens in the service, exactly like academy_members).
CREATE POLICY "academy_invites_tenant_all" ON "academy_invites"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_invites"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_invites"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- Registration redeems an invite before the user exists: a SECURITY DEFINER
-- function claims the token atomically (no policy for anonymous callers).
CREATE OR REPLACE FUNCTION claim_academy_invite(p_academy_id text, p_token_hash text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed integer;
BEGIN
  UPDATE "academy_invites"
  SET "used_count" = "used_count" + 1
  WHERE "academy_id" = p_academy_id
    AND "token_hash" = p_token_hash
    AND "revoked_at" IS NULL
    AND "expires_at" > now()
    AND "used_count" < "max_uses";
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed = 1;
END;
$$;

-- Registration policy is read before the user exists, too.
CREATE OR REPLACE FUNCTION resolve_academy_registration_policy(p_academy_id text)
RETURNS "academy_registration_policy"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a."registration_policy" FROM "academies" a
  WHERE a."id" = p_academy_id AND a."archived_at" IS NULL;
$$;

-- ----------------------------------------------------------------------------
-- 3. refresh_tokens — session surface (AD-5)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "session_surface" AS ENUM ('management', 'academy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "surface" "session_surface" NOT NULL DEFAULT 'management',
  ADD COLUMN IF NOT EXISTS "academy_id" TEXT;

-- Backfill: a session belonging to a user who holds student rows and no
-- staff fact was created by a learner and therefore lives on the academy
-- surface; the academy is their single (or earliest) membership.
UPDATE "refresh_tokens" rt
SET "surface" = 'academy',
    "academy_id" = (
      SELECT s."academy_id" FROM "academy_students" s
      WHERE s."user_id" = rt."user_id" ORDER BY s."joined_at" ASC LIMIT 1
    )
WHERE rt."revoked_at" IS NULL
  AND rt."surface" = 'management'
  AND EXISTS (SELECT 1 FROM "academy_students" s WHERE s."user_id" = rt."user_id")
  AND NOT EXISTS (SELECT 1 FROM "organization_memberships" om WHERE om."user_id" = rt."user_id")
  AND NOT EXISTS (SELECT 1 FROM "academy_members" am WHERE am."user_id" = rt."user_id")
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = rt."user_id" AND u."is_platform_owner" = true);

-- ----------------------------------------------------------------------------
-- 4. quiz_attempts — attempt-number uniqueness and one open attempt
-- ----------------------------------------------------------------------------
-- Dedupe deterministically: within (quiz, student), renumber attempts by
-- creation order. Rows that already carry distinct, ordered numbers are
-- unchanged by this statement.
WITH ordered AS (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "quiz_id", "student_id" ORDER BY "created_at", "id") AS rn
  FROM "quiz_attempts"
)
UPDATE "quiz_attempts" qa
SET "attempt_number" = o.rn
FROM ordered o
WHERE o."id" = qa."id" AND qa."attempt_number" <> o.rn;

-- More than one open attempt per (quiz, student) — keep the newest open,
-- mark the older ones submitted-as-abandoned (status `failed`, score 0)
-- so the partial unique index below can be created. Never deletes.
UPDATE "quiz_attempts" qa
SET "status" = 'failed', "score" = 0, "passed" = false, "submitted_at" = now()
FROM (
  SELECT "id",
         ROW_NUMBER() OVER (PARTITION BY "quiz_id", "student_id" ORDER BY "created_at" DESC, "id" DESC) AS rn
  FROM "quiz_attempts"
  WHERE "status" = 'in_progress'
) open_rows
WHERE open_rows."id" = qa."id" AND open_rows.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_quiz_id_student_id_attempt_number_key"
  ON "quiz_attempts"("quiz_id", "student_id", "attempt_number");

CREATE UNIQUE INDEX IF NOT EXISTS "quiz_attempts_one_open_per_student_idx"
  ON "quiz_attempts"("quiz_id", "student_id")
  WHERE "status" = 'in_progress';

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------

-- 5a. `is_academy_student` now means an ACTIVE, UNBLOCKED membership. Every
-- policy already keyed on it (enrollments_self_insert, announcements
-- student read) inherits the stricter meaning.
CREATE OR REPLACE FUNCTION is_academy_student(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_students"
    WHERE "academy_id" = p_academy_id
      AND "user_id" = p_user_id
      AND "status" = 'active'
      AND "blocked_at" IS NULL
  );
$$;

-- 5b. Review tier: the course's instructor OR the owning academy's
-- owner/administrator/manager (RBAC matrix rows "view attempts, answers,
-- submissions" and "grade").
CREATE OR REPLACE FUNCTION can_review_course(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "course_instructors"
      WHERE "course_id" = p_course_id AND "user_id" = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academy_members" am ON am."academy_id" = c."academy_id"
      WHERE c."id" = p_course_id
        AND am."user_id" = p_user_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    );
$$;

CREATE POLICY "quiz_attempts_review_select" ON "quiz_attempts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_attempts"."quiz_id"
        AND can_review_course(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "assignment_submissions_review_select" ON "assignment_submissions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND can_review_course(a."course_id", current_setting('app.current_user_id', true))
    )
  );

-- Grading write: replaces the instructor-only UPDATE policy with the review tier.
DROP POLICY IF EXISTS "assignment_submissions_instructor_update" ON "assignment_submissions";
CREATE POLICY "assignment_submissions_review_update" ON "assignment_submissions"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND can_review_course(a."course_id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND can_review_course(a."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "lesson_progress_review_select" ON "lesson_progress"
  FOR SELECT
  USING (can_review_course("lesson_progress"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "course_progress_review_select" ON "course_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND can_review_course(e."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "enrollments_review_select" ON "enrollments"
  FOR SELECT
  USING (can_review_course("enrollments"."course_id", current_setting('app.current_user_id', true)));

-- 5c. Author tier on curriculum reads under a user-only context: the
-- draft-course authoring 500 (an owner attaching a quiz to a section of a
-- draft course could not see the section; only tenant/instructor/public/
-- enrolled policies existed).
CREATE POLICY "course_sections_author_select" ON "course_sections"
  FOR SELECT
  USING (can_author_course_content("course_sections"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "course_lessons_author_select" ON "course_lessons"
  FOR SELECT
  USING (can_author_course_content("course_lessons"."course_id", current_setting('app.current_user_id', true)));

-- 5d. Owner/manager analytics read attempts under tenant context (the
-- "failing quiz" signal could never fire before).
CREATE POLICY "quiz_attempts_tenant_select" ON "quiz_attempts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      JOIN "courses" c ON c."id" = q."course_id"
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE q."id" = "quiz_attempts"."quiz_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- 5e. Roster visibility: owner/administrator/manager see the whole academy;
-- an instructor sees only students enrolled in a course they teach.
DROP POLICY IF EXISTS "academy_students_staff_select" ON "academy_students";

CREATE OR REPLACE FUNCTION can_view_academy_student(p_academy_id text, p_student_user_id text, p_viewer_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "academy_members" am
      WHERE am."academy_id" = p_academy_id
        AND am."user_id" = p_viewer_id
        AND am."status" = 'active'
        AND am."role" IN ('owner', 'administrator', 'manager')
    )
    OR EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "course_instructors" ci ON ci."course_id" = e."course_id"
      WHERE e."academy_id" = p_academy_id
        AND e."student_id" = p_student_user_id
        AND ci."user_id" = p_viewer_id
    );
$$;

CREATE POLICY "academy_students_staff_select" ON "academy_students"
  FOR SELECT
  USING (
    can_view_academy_student(
      "academy_students"."academy_id",
      "academy_students"."user_id",
      current_setting('app.current_user_id', true)
    )
  );

-- Owner/administrator/manager may block/unblock and update roster facts
-- under tenant context (role check in the service).
CREATE POLICY "academy_students_tenant_update" ON "academy_students"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_students"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_students"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- 5f. enrollments — the student's own UPDATE may change progress facts only.
-- Lifecycle and ownership columns are immutable for a self-context write;
-- staff writes carry a tenant context and are unaffected. A trigger is used
-- because a WITH CHECK clause cannot compare OLD and NEW.
CREATE OR REPLACE FUNCTION enrollments_guard_self_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.current_organization_id', true) IS NULL
     OR current_setting('app.current_organization_id', true) = '' THEN
    IF NEW."student_id" IS DISTINCT FROM OLD."student_id"
       OR NEW."course_id" IS DISTINCT FROM OLD."course_id"
       OR NEW."academy_id" IS DISTINCT FROM OLD."academy_id"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
       OR NEW."revoke_reason" IS DISTINCT FROM OLD."revoke_reason"
       OR NEW."access_source" IS DISTINCT FROM OLD."access_source"
       OR NEW."course_order_id" IS DISTINCT FROM OLD."course_order_id"
       OR (OLD."status" = 'unavailable' AND NEW."status" IS DISTINCT FROM OLD."status")
       OR (OLD."revoked_at" IS NOT NULL AND NEW."status" IS DISTINCT FROM OLD."status")
    THEN
      RAISE EXCEPTION 'enrollment lifecycle columns are immutable in a self context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "enrollments_guard_self_update_trg" ON "enrollments";
CREATE TRIGGER "enrollments_guard_self_update_trg"
  BEFORE UPDATE ON "enrollments"
  FOR EACH ROW
  EXECUTE FUNCTION enrollments_guard_self_update();

-- Staff enrollment lifecycle writes (manual enroll, revoke, extend) run under
-- the owning organization's tenant context.
CREATE POLICY "enrollments_tenant_insert" ON "enrollments"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "enrollments"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "enrollments_tenant_update" ON "enrollments"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "enrollments"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "enrollments"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- Progress rows materialized by staff enrollments (same tenant context).
CREATE POLICY "course_progress_tenant_insert" ON "course_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "academies" a ON a."id" = e."academy_id"
      WHERE e."id" = "course_progress"."enrollment_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_progress_tenant_select" ON "course_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "academies" a ON a."id" = e."academy_id"
      WHERE e."id" = "course_progress"."enrollment_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "lesson_progress_tenant_insert" ON "lesson_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "academies" a ON a."id" = e."academy_id"
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "lesson_progress_tenant_select" ON "lesson_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      JOIN "academies" a ON a."id" = e."academy_id"
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
