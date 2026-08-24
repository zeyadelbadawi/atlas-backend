-- CreateEnum
CREATE TYPE "enrollment_status" AS ENUM ('available', 'pending', 'enrolled', 'completed', 'unavailable');

-- CreateEnum
CREATE TYPE "course_completion_state" AS ENUM ('incomplete', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "certificate_status" AS ENUM ('unavailable', 'eligible');

-- CreateEnum
CREATE TYPE "lesson_progress_status" AS ENUM ('locked', 'available', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "quiz_status" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "quiz_question_type" AS ENUM ('single_choice', 'multiple_choice', 'true_false');

-- CreateEnum
CREATE TYPE "quiz_attempt_status" AS ENUM ('not_started', 'in_progress', 'submitted', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "assignment_status" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "assignment_submission_status" AS ENUM ('draft', 'submitting', 'submitted', 'failed');

-- CreateEnum
CREATE TYPE "submission_grading_status" AS ENUM ('ungraded', 'graded');

-- CreateTable
CREATE TABLE "enrollments" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "status" "enrollment_status" NOT NULL,
    "enrolled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_progress" (
    "enrollment_id" TEXT NOT NULL,
    "total_lessons" INTEGER NOT NULL,
    "completed_lessons" INTEGER NOT NULL DEFAULT 0,
    "percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "current_lesson_id" TEXT,
    "completion_state" "course_completion_state" NOT NULL DEFAULT 'incomplete',
    "certificate_status" "certificate_status" NOT NULL DEFAULT 'unavailable',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "course_progress_pkey" PRIMARY KEY ("enrollment_id")
);

-- CreateTable
CREATE TABLE "lesson_progress" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "status" "lesson_progress_status" NOT NULL DEFAULT 'locked',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quizzes" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "section_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "quiz_status" NOT NULL DEFAULT 'draft',
    "passing_score" INTEGER,
    "max_attempts" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_questions" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "type" "quiz_question_type" NOT NULL,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_question_options" (
    "id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_question_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quiz_attempts" (
    "id" TEXT NOT NULL,
    "quiz_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" "quiz_attempt_status" NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "score" DECIMAL(5,2),
    "passed" BOOLEAN,
    "submitted_at" TIMESTAMP(3),
    "attempt_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quiz_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "section_id" TEXT,
    "lesson_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "status" "assignment_status" NOT NULL DEFAULT 'draft',
    "due_at" TIMESTAMP(3),
    "allow_resubmission" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_submissions" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" "assignment_submission_status" NOT NULL,
    "response" TEXT,
    "attachment_url" TEXT,
    "submitted_at" TIMESTAMP(3),
    "grading_status" "submission_grading_status" NOT NULL DEFAULT 'ungraded',
    "score" DECIMAL(5,2),
    "feedback" TEXT,
    "graded_at" TIMESTAMP(3),
    "graded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollments_student_id_status_idx" ON "enrollments"("student_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_student_id_course_id_key" ON "enrollments"("student_id", "course_id");

-- CreateIndex
CREATE INDEX "lesson_progress_enrollment_id_status_idx" ON "lesson_progress"("enrollment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_progress_enrollment_id_lesson_id_key" ON "lesson_progress"("enrollment_id", "lesson_id");

-- CreateIndex
CREATE INDEX "quizzes_course_id_status_idx" ON "quizzes"("course_id", "status");

-- CreateIndex
CREATE INDEX "quiz_questions_quiz_id_order_idx" ON "quiz_questions"("quiz_id", "order");

-- CreateIndex
CREATE INDEX "quiz_attempts_student_id_quiz_id_attempt_number_idx" ON "quiz_attempts"("student_id", "quiz_id", "attempt_number");

-- CreateIndex
CREATE INDEX "assignments_course_id_status_idx" ON "assignments"("course_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_submissions_assignment_id_student_id_key" ON "assignment_submissions"("assignment_id", "student_id");

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_progress" ADD CONSTRAINT "course_progress_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "course_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_question_options" ADD CONSTRAINT "quiz_question_options_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "quiz_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_fkey" FOREIGN KEY ("quiz_id") REFERENCES "quizzes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_submissions" ADD CONSTRAINT "assignment_submissions_graded_by_fkey" FOREIGN KEY ("graded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- P6 Row-Level Security (master plan §5.3/§5.4/§7, §21 Phase P6).
--
-- Two distinct RLS shapes in this migration, both reusing mechanisms that
-- already exist — no new session variable, no new tenancy model:
--
-- (1) STUDENT-SELF-SCOPED tables (`enrollments`, `course_progress`,
--     `lesson_progress`, `quiz_attempts`, `assignment_submissions`) — a
--     student is never an `organization_memberships`/`academy_members`
--     row, so `app.current_organization_id` cannot express "this row
--     belongs to the signed-in student." Reuses `app.current_user_id`
--     instead — the exact session variable P2 already introduced
--     (`organizations_member_select`/`organization_memberships_self_select`,
--     `20260823182500_p2_self_membership_rls_policies`) for the identical
--     shape of problem ("a query genuinely scoped by user, not by any one
--     tenant"). `enrollments`/`quiz_attempts`/`assignment_submissions`
--     check `student_id` directly; `course_progress`/`lesson_progress`
--     resolve it one hop transitively through `enrollment_id`.
--
-- (2) READ-ONLY CONTENT tables (`quizzes`, `quiz_questions`,
--     `quiz_question_options`, `assignments`) — no write endpoint exists in
--     P6 (see schema.prisma's P6 header comment), so these get SELECT-only
--     policies, transitively resolved through `enrollments` (the student
--     must hold an active enrollment in the quiz's/assignment's course) —
--     no INSERT/UPDATE/DELETE policy at all, denied by default, matching
--     `course_categories`/`course_instructors`'s exact precedent from P5.
--
-- (3) ADDITIVE, narrow, context-independent SELECT policies on the
--     PRE-EXISTING `courses`/`course_categories`/`course_instructors`
--     tables (P5) — `discoverCourses`/`discoverCourse` need to read a
--     published+public course regardless of the caller's organization
--     membership, which a student structurally never has. Postgres
--     evaluates multiple SELECT policies on the same table with OR
--     semantics, so this never weakens or replaces P5's own
--     `*_tenant_select` policy — it only adds a second, legitimate,
--     narrow read path for rows that are already publicly discoverable by
--     design (`status = 'published' AND visibility = 'public'`). No
--     `ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` needed here — P5
--     already did that for all three tables.
-- ============================================================================

CREATE POLICY "courses_public_discovery_select" ON "courses"
  FOR SELECT
  USING (
    "courses"."status" = 'published'
    AND "courses"."visibility" = 'public'
  );

CREATE POLICY "course_categories_public_discovery_select" ON "course_categories"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."category_id" = "course_categories"."id"
        AND c."status" = 'published'
        AND c."visibility" = 'public'
    )
  );

CREATE POLICY "course_instructors_public_discovery_select" ON "course_instructors"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = "course_instructors"."course_id"
        AND c."status" = 'published'
        AND c."visibility" = 'public'
    )
  );

ALTER TABLE "enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "enrollments_self_select" ON "enrollments"
  FOR SELECT
  USING ("enrollments"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "enrollments_self_insert" ON "enrollments"
  FOR INSERT
  WITH CHECK ("enrollments"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "enrollments_self_update" ON "enrollments"
  FOR UPDATE
  USING ("enrollments"."student_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("enrollments"."student_id"::text = current_setting('app.current_user_id', true));

ALTER TABLE "course_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "course_progress" FORCE ROW LEVEL SECURITY;

CREATE POLICY "course_progress_self_select" ON "course_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "course_progress_self_insert" ON "course_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "course_progress_self_update" ON "course_progress"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "lesson_progress" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lesson_progress" FORCE ROW LEVEL SECURITY;

CREATE POLICY "lesson_progress_self_select" ON "lesson_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "lesson_progress_self_insert" ON "lesson_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "lesson_progress_self_update" ON "lesson_progress"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
    )
  );

ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quizzes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "quizzes_enrolled_select" ON "quizzes"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."course_id" = "quizzes"."course_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );

ALTER TABLE "quiz_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_questions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "quiz_questions_enrolled_select" ON "quiz_questions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      JOIN "enrollments" e ON e."course_id" = q."course_id"
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );

ALTER TABLE "quiz_question_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_question_options" FORCE ROW LEVEL SECURITY;

CREATE POLICY "quiz_question_options_enrolled_select" ON "quiz_question_options"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      JOIN "enrollments" e ON e."course_id" = q."course_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );

ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_attempts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "quiz_attempts_self_select" ON "quiz_attempts"
  FOR SELECT
  USING ("quiz_attempts"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "quiz_attempts_self_insert" ON "quiz_attempts"
  FOR INSERT
  WITH CHECK ("quiz_attempts"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "quiz_attempts_self_update" ON "quiz_attempts"
  FOR UPDATE
  USING ("quiz_attempts"."student_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("quiz_attempts"."student_id"::text = current_setting('app.current_user_id', true));

ALTER TABLE "assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignments" FORCE ROW LEVEL SECURITY;

CREATE POLICY "assignments_enrolled_select" ON "assignments"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."course_id" = "assignments"."course_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        AND e."status" IN ('enrolled', 'completed')
    )
  );

ALTER TABLE "assignment_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assignment_submissions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "assignment_submissions_self_select" ON "assignment_submissions"
  FOR SELECT
  USING ("assignment_submissions"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "assignment_submissions_self_insert" ON "assignment_submissions"
  FOR INSERT
  WITH CHECK ("assignment_submissions"."student_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "assignment_submissions_self_update" ON "assignment_submissions"
  FOR UPDATE
  USING ("assignment_submissions"."student_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("assignment_submissions"."student_id"::text = current_setting('app.current_user_id', true));

-- ============================================================================
-- Additive discovery-read policies on `course_sections`/`course_lessons`
-- (P5 tables) — discovered necessary while implementing
-- `EnrollmentsService.createEnrollment` (P6): materializing `lesson_progress`
-- at enrollment time requires reading a published course's real sections/
-- lessons, but the P5 `course_sections_tenant_select`/
-- `course_lessons_tenant_select` policies are scoped to
-- `app.current_organization_id` — a session variable this code path never
-- sets (P6 runs under `app.current_user_id`, per this migration's own
-- header comment, since a student is never an organization member).
-- Mirrors `courses_public_discovery_select`'s exact shape and reasoning
-- from earlier in this same migration: additive, narrow, context-
-- independent, OR'd alongside the existing tenant-scoped policy, never
-- replacing or weakening it.
-- ============================================================================

CREATE POLICY "course_sections_public_discovery_select" ON "course_sections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = "course_sections"."course_id"
        AND c."status" = 'published'
        AND c."visibility" = 'public'
    )
  );

CREATE POLICY "course_lessons_public_discovery_select" ON "course_lessons"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      WHERE c."id" = "course_lessons"."course_id"
        AND c."status" = 'published'
        AND c."visibility" = 'public'
    )
  );
