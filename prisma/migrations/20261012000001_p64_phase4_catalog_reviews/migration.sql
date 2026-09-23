-- P64 Phase 4 — catalog metadata + course reviews. Additive and
-- production-safe. Correctly ordered AFTER the Phase 3 migrations that create
-- `certificate_templates` and after the invite-binding migration.

-- Idempotent belt for the certificate palette columns: on a FRESH replay the
-- 20260923021943 migration no-ops (it sorts before `certificate_templates`
-- exists), so ensure the columns here where the table certainly exists. On an
-- already-migrated database (production) these are no-ops.
ALTER TABLE "certificate_templates"
  ADD COLUMN IF NOT EXISTS "primary_color"    TEXT NOT NULL DEFAULT '#1F4E5F',
  ADD COLUMN IF NOT EXISTS "accent_color"     TEXT NOT NULL DEFAULT '#B08A3E',
  ADD COLUMN IF NOT EXISTS "text_color"       TEXT NOT NULL DEFAULT '#14303A',
  ADD COLUMN IF NOT EXISTS "background_color" TEXT NOT NULL DEFAULT '#FCFBF7';

-- CreateEnum
CREATE TYPE "course_level" AS ENUM ('beginner', 'intermediate', 'advanced', 'all_levels');
CREATE TYPE "course_review_status" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable — catalog metadata on courses (all nullable/empty; existing rows unaffected)
ALTER TABLE "courses"
  ADD COLUMN "intro_video_asset_id" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "level" "course_level",
  ADD COLUMN "outcomes" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "course_reviews" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "status" "course_review_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "course_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "course_reviews_course_id_status_idx" ON "course_reviews"("course_id", "status");
CREATE INDEX "course_reviews_academy_id_idx" ON "course_reviews"("academy_id");
CREATE UNIQUE INDEX "course_reviews_course_id_student_id_key" ON "course_reviews"("course_id", "student_id");

ALTER TABLE "courses" ADD CONSTRAINT "courses_intro_video_asset_id_fkey" FOREIGN KEY ("intro_video_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "course_reviews" ADD CONSTRAINT "course_reviews_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_reviews" ADD CONSTRAINT "course_reviews_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_reviews" ADD CONSTRAINT "course_reviews_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A SECURITY DEFINER predicate for "this course is published + public", so the
-- public review read does not evaluate the (expensive, recursive) courses RLS
-- policies per review row (the B5 performance lesson). Caller-independent;
-- reads only two non-sensitive status columns.
CREATE OR REPLACE FUNCTION course_is_published_public(p_course_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "courses" c
    WHERE c."id" = p_course_id
      AND c."status" = 'published'
      AND c."visibility" = 'public'
  );
$$;

-- RLS: guard decides and RLS independently agrees (cross-phase requirement 2).
ALTER TABLE "course_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_reviews" FORCE ROW LEVEL SECURITY;

-- Public discovery: an APPROVED review of a published+public course, readable
-- anonymously (no user context required).
CREATE POLICY "course_reviews_public_select" ON "course_reviews"
  FOR SELECT
  USING ("status" = 'approved' AND course_is_published_public("course_id"));

-- The author always sees their own review, in any moderation state.
CREATE POLICY "course_reviews_self_select" ON "course_reviews"
  FOR SELECT
  USING ("student_id" = current_setting('app.current_user_id', true));

-- Course reviewer (instructor / academy owner / manager) sees all reviews of
-- their course for moderation.
CREATE POLICY "course_reviews_review_select" ON "course_reviews"
  FOR SELECT
  USING (can_review_course("course_id", current_setting('app.current_user_id', true)));

-- Platform owner.
CREATE POLICY "course_reviews_platform_select" ON "course_reviews"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- Only an enrolled learner may create their OWN review.
CREATE POLICY "course_reviews_self_insert" ON "course_reviews"
  FOR INSERT
  WITH CHECK (
    "student_id" = current_setting('app.current_user_id', true)
    AND is_enrolled_in_course("course_id", current_setting('app.current_user_id', true))
  );

-- The author may edit their own review (the service resets it to `pending`).
CREATE POLICY "course_reviews_self_update" ON "course_reviews"
  FOR UPDATE
  USING ("student_id" = current_setting('app.current_user_id', true))
  WITH CHECK ("student_id" = current_setting('app.current_user_id', true));

-- A reviewer moderates (approve/reject) reviews of their course.
CREATE POLICY "course_reviews_review_update" ON "course_reviews"
  FOR UPDATE
  USING (can_review_course("course_id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_review_course("course_id", current_setting('app.current_user_id', true)));

-- The author may delete their own review; a reviewer may remove one from their course.
CREATE POLICY "course_reviews_self_delete" ON "course_reviews"
  FOR DELETE
  USING ("student_id" = current_setting('app.current_user_id', true));
CREATE POLICY "course_reviews_review_delete" ON "course_reviews"
  FOR DELETE
  USING (can_review_course("course_id", current_setting('app.current_user_id', true)));
