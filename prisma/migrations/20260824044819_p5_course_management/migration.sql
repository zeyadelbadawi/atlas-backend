-- CreateEnum
CREATE TYPE "course_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "course_visibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "course_pricing_type" AS ENUM ('free', 'paid');

-- CreateEnum
CREATE TYPE "course_lesson_content_type" AS ENUM ('text', 'video', 'file');

-- CreateEnum
CREATE TYPE "course_lesson_status" AS ENUM ('draft', 'published');

-- CreateTable
CREATE TABLE "course_categories" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "category_id" TEXT,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "short_description" TEXT,
    "thumbnail_url" TEXT,
    "status" "course_status" NOT NULL DEFAULT 'draft',
    "visibility" "course_visibility" NOT NULL DEFAULT 'private',
    "pricing_type" "course_pricing_type" NOT NULL DEFAULT 'free',
    "pricing_amount_minor_units" BIGINT,
    "pricing_currency" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_instructors" (
    "course_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_instructors_pkey" PRIMARY KEY ("course_id","user_id")
);

-- CreateTable
CREATE TABLE "course_sections" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_lessons" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL,
    "content_type" "course_lesson_content_type" NOT NULL,
    "content_url" TEXT,
    "status" "course_lesson_status" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_categories_academy_id_idx" ON "course_categories"("academy_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_categories_academy_id_slug_key" ON "course_categories"("academy_id", "slug");

-- CreateIndex
CREATE INDEX "courses_academy_id_status_visibility_idx" ON "courses"("academy_id", "status", "visibility");

-- CreateIndex
CREATE INDEX "courses_status_visibility_idx" ON "courses"("status", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "courses_academy_id_slug_key" ON "courses"("academy_id", "slug");

-- CreateIndex
CREATE INDEX "course_instructors_user_id_idx" ON "course_instructors"("user_id");

-- CreateIndex
CREATE INDEX "course_sections_course_id_order_idx" ON "course_sections"("course_id", "order");

-- CreateIndex
CREATE INDEX "course_lessons_section_id_order_idx" ON "course_lessons"("section_id", "order");

-- AddForeignKey
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "course_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_instructors" ADD CONSTRAINT "course_instructors_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_instructors" ADD CONSTRAINT "course_instructors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_sections" ADD CONSTRAINT "course_sections_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_lessons" ADD CONSTRAINT "course_lessons_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- Every P5 table is Academy-scoped, resolving tenant ownership transitively
-- (`courses.academy_id → academies.organization_id`, `course_categories.
-- academy_id → academies.organization_id`, `course_sections.course_id →
-- courses.academy_id → ...`, `course_lessons.section_id → course_sections.
-- course_id → ...` — using `course_lessons.course_id`, the denormalized
-- column, to shortcut one hop). Reuses the exact P2/P3 session variable
-- (`app.current_organization_id`) — no new session variable, no
-- `app.current_academy_id`.
--
-- No new bootstrap policy is needed (unlike Academy's own
-- `academies_org_member_select`): every P5 route nests under
-- `academies/:academyId/courses/...` — the ACADEMY id is always the URL's
-- own `:id` segment, already resolved and re-verified by the existing,
-- unmodified `AcademyScopeGuard` before any course/section/lesson query
-- ever runs. Course/section/lesson ids are always secondary path segments,
-- verified by ordinary application-layer ownership-chain queries (ordinary
-- ownership checks, ordinary rows) inside the tenant context that guard
-- already established — never a case of "resolve tenant context from only
-- a course id," the exact problem the Academy bootstrap policy exists to
-- solve.
--
-- Command coverage, deliberate:
--   SELECT — tenant-scoped (transitively) on all five tables.
--   INSERT — narrow, NOT `WITH CHECK (true)`, on all five tables — even
--     `course_categories`/`course_instructors`, which have NO write
--     endpoint in P5 (see schema.prisma's doc comment on both models: no
--     `CourseService` method creates either; both are read-only,
--     confirmed against the actual frontend). Matches P2's
--     `organizations_insert`/P4's `tenant_subscriptions_insert`
--     precedent exactly: the policy governs the `atlas_app` ROLE, not
--     which endpoints currently call it, so it lands the moment the table
--     exists — defense-in-depth against a future bug or unreviewed code
--     path, not merely "not needed yet." Seed/fixture data for both
--     tables is written via the admin superuser connection (`DATABASE_URL`,
--     never `atlas_app`), exactly like `organizations`/`tenant_subscriptions`
--     fixtures already are.
--   UPDATE — `courses`, `course_sections`, `course_lessons` (the three
--     tables P5 actually adds write capability for beyond creation). Both
--     `USING`/`WITH CHECK` pin the row's tenant ownership to the active
--     context, exactly like `academies_tenant_update`/
--     `tenant_usage_tenant_update` — structurally impossible to move a
--     row's `academy_id`/`course_id`/`section_id` to a different tenant's
--     hierarchy via UPDATE. No UPDATE policy on `course_categories`/
--     `course_instructors` (no endpoint updates either).
--   DELETE — `course_sections`/`course_lessons` only (real SQL DELETE —
--     neither has a soft-delete state machine, see schema.prisma's doc
--     comments on `CourseLessonStatus`/`CourseSection`). NO DELETE policy
--     on `courses` — `DELETE /academies/:id/courses/:id` is a status
--     transition to `archived`, never a SQL DELETE, matching `Academy`'s
--     own precedent exactly. NO DELETE policy on `course_categories`/
--     `course_instructors` either — no endpoint deletes either.
-- ============================================================================

ALTER TABLE "course_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_categories" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_categories_tenant_select" ON "course_categories"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "course_categories"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_categories_insert" ON "course_categories"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "course_categories"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courses" FORCE ROW LEVEL SECURITY;

CREATE POLICY "courses_tenant_select" ON "courses"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "courses"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "courses_insert" ON "courses"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "courses"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "courses_tenant_update" ON "courses"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "courses"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "courses"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "course_instructors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_instructors" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_instructors_tenant_select" ON "course_instructors"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_instructors"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_instructors_insert" ON "course_instructors"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_instructors"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "course_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_sections" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_sections_tenant_select" ON "course_sections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_sections"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_sections_insert" ON "course_sections"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_sections"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_sections_tenant_update" ON "course_sections"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_sections"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_sections"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_sections_tenant_delete" ON "course_sections"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_sections"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "course_lessons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_lessons" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_lessons_tenant_select" ON "course_lessons"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_lessons"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_lessons_insert" ON "course_lessons"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_lessons"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_lessons_tenant_update" ON "course_lessons"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_lessons"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_lessons"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "course_lessons_tenant_delete" ON "course_lessons"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_lessons"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
