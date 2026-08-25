-- CreateEnum
CREATE TYPE "announcement_audience" AS ENUM ('platform', 'academy', 'course');

-- CreateEnum
CREATE TYPE "announcement_status" AS ENUM ('draft', 'scheduled', 'published', 'archived');

-- CreateEnum
CREATE TYPE "blog_post_status" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "forum_status" AS ENUM ('open', 'locked', 'archived');

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "audience" "announcement_audience" NOT NULL,
    "academy_id" TEXT,
    "course_id" TEXT,
    "author_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "announcement_status" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blog_posts" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT,
    "author_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "excerpt" TEXT,
    "content" TEXT NOT NULL,
    "featured_image_url" TEXT,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "blog_post_status" NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forums" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "forum_status" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_threads" (
    "id" TEXT NOT NULL,
    "forum_id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forum_replies" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forum_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_course_id_status_idx" ON "announcements"("course_id", "status");

-- CreateIndex
CREATE INDEX "announcements_academy_id_status_idx" ON "announcements"("academy_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "blog_posts_academy_id_slug_key" ON "blog_posts"("academy_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "forums_course_id_key" ON "forums"("course_id");

-- CreateIndex
CREATE INDEX "forum_threads_forum_id_pinned_created_at_idx" ON "forum_threads"("forum_id", "pinned", "created_at");

-- CreateIndex
CREATE INDEX "forum_replies_thread_id_created_at_idx" ON "forum_replies"("thread_id", "created_at");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forums" ADD CONSTRAINT "forums_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_forum_id_fkey" FOREIGN KEY ("forum_id") REFERENCES "forums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- P7 Row-Level Security (master plan §5.5/§7/§9, §21 Phase P7).
--
-- Every policy below runs under `app.current_user_id` exclusively (P2's
-- session variable, reused verbatim — see schema.prisma's P7 header
-- comment for why `app.current_organization_id` cannot express any of
-- this: every P7 resource is reached through a flat or course-nested route
-- with no `:academyId`/`:organizationId` URL segment, and several must be
-- reachable by an enrolled STUDENT, who is never an organization member).
--
-- PART 0 — four `SECURITY DEFINER` helper functions, and why they exist
-- (discovered during implementation, not designed up front):
--
--   1. `is_course_instructor`/`is_academy_member` exist because a plain
--      `EXISTS (SELECT ... course_instructors ...)`/`EXISTS (SELECT ...
--      academy_members ...)` subquery directly inside a `courses`/
--      `academies` policy would make that table's policy set and
--      `course_instructors`'s/`academy_members`'s OWN pre-existing P5/P3
--      policies (which already reference `courses`/`academies` back)
--      mutually referential — Postgres detects this as circular and
--      refuses with "infinite recursion detected in policy for relation"
--      for EVERY query against the table, from any caller, regardless of
--      which policy would actually apply. Reproduced and confirmed against
--      this exact migration during implementation.
--   2. `is_course_participant`/`is_course_moderator` exist for a second,
--      distinct reason: not a true cycle, but a genuine performance
--      problem. The Community tables nest three deep (`forum_replies` →
--      `forum_threads` → `forums`/`courses`), and each of those tables
--      is itself RLS-protected — a plain nested `EXISTS` chain forces
--      Postgres to re-evaluate a full OR'd policy set at every join level,
--      compounding into multi-second query times even against a handful
--      of rows (measured directly: ~5.5s on a table with single-digit row
--      counts, confirmed via per-step timing that ruled out slow
--      individual queries — every query in isolation profiled under
--      50ms). A `SECURITY DEFINER` function collapses each level to one
--      cheap, RLS-bypassing boolean check, exactly like functions 1
--      already do for the narrower circular case.
--
-- All four are owned by the migration role (the same elevated connection
-- `test/utils/db-admin.ts`/`prisma/seed.ts` call "the migration
-- superuser") — the `SELECT` inside each runs with that owner's
-- privileges, bypassing RLS for this one narrow, purpose-built check only,
-- never a blanket bypass. The tables they read (`course_instructors`,
-- `academy_members`, `enrollments`, `courses`) keep every one of their own
-- pre-existing policies completely unrevised — these functions are read
-- paths only, used exclusively from other tables' policies below.
-- ============================================================================

CREATE FUNCTION is_course_instructor(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "course_instructors"
    WHERE "course_id" = p_course_id AND "user_id" = p_user_id
  );
$$;

CREATE FUNCTION is_academy_member(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_members"
    WHERE "academy_id" = p_academy_id AND "user_id" = p_user_id
  );
$$;

/** Any real, legitimate reason a user may participate in a course's Community/grading surface: an actively enrolled student, the course's real instructor, or any staff member of the owning academy. */
CREATE FUNCTION is_course_participant(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "enrollments"
      WHERE "course_id" = p_course_id
        AND "student_id" = p_user_id
        AND "status" IN ('enrolled', 'completed')
    )
    OR EXISTS (
      SELECT 1 FROM "course_instructors"
      WHERE "course_id" = p_course_id AND "user_id" = p_user_id
    )
    OR EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academy_members" am ON am."academy_id" = c."academy_id"
      WHERE c."id" = p_course_id AND am."user_id" = p_user_id
    );
$$;

/** Narrower than `is_course_participant` — the course's real instructor, or the owning academy's `owner`/`administrator`. Matches `CoursesService.assertCanManage`'s (P5) exact write-authorization shape, applied to forum moderation and Community authoring. */
CREATE FUNCTION is_course_moderator(p_course_id text, p_user_id text)
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
        AND am."role" IN ('owner', 'administrator')
    );
$$;

-- ---------------------------------------------------------------------------
-- PART 1 — two more additive self-select policies, same reasoning as the
-- functions above: `academy_members`/`course_instructors` each currently
-- carry only an `app.current_organization_id`-keyed SELECT policy, so a
-- direct (non-function) read of a user's own row under
-- `app.current_user_id` — e.g. `AnnouncementsService.assertCanManage`
-- reading a caller's own academy membership — needs its own additive
-- policy. Mirrors `organization_memberships_self_select`'s exact
-- precedent from P2 (`20260823182500_p2_self_membership_rls_policies`),
-- applied twice more.
-- ---------------------------------------------------------------------------

CREATE POLICY "academy_members_self_select" ON "academy_members"
  FOR SELECT
  USING ("academy_members"."user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "course_instructors_self_select" ON "course_instructors"
  FOR SELECT
  USING ("course_instructors"."user_id"::text = current_setting('app.current_user_id', true));

-- `academies` itself, additive: Prisma's nested `academy: { connect: { id } }`
-- (`Announcement`/`BlogPost` both have a real `Academy` relation, not a
-- plain scalar column) needs `academies` readable under
-- `app.current_user_id` — the pre-existing P3 policies are
-- `app.current_organization_id`-keyed only.
CREATE POLICY "academies_academy_member_select" ON "academies"
  FOR SELECT
  USING (is_academy_member("academies"."id", current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- PART 2 — announcements / blog_posts / forums / forum_threads / forum_replies
-- ---------------------------------------------------------------------------

ALTER TABLE "announcements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "announcements" FORCE ROW LEVEL SECURITY;

-- Platform-wide published announcements: everyone, no dependency — same
-- shape as `courses_public_discovery_select` (P6).
CREATE POLICY "announcements_platform_select" ON "announcements"
  FOR SELECT
  USING ("announcements"."audience" = 'platform' AND "announcements"."status" = 'published');

-- Academy-wide published announcements: any real academy member.
CREATE POLICY "announcements_academy_member_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."status" = 'published'
    AND "announcements"."academy_id" IS NOT NULL
    AND is_academy_member("announcements"."academy_id", current_setting('app.current_user_id', true))
  );

-- Course-scoped published announcements: any real course participant.
CREATE POLICY "announcements_course_participant_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."status" = 'published'
    AND "announcements"."course_id" IS NOT NULL
    AND is_course_participant("announcements"."course_id", current_setting('app.current_user_id', true))
  );

-- Authoring/management view: the academy `owner`/`administrator` of the
-- course's own academy sees and manages every status — the one write
-- surface `AnnouncementService` actually defines (course-scoped create/
-- update/publish/archive; see schema.prisma's `Announcement` doc comment
-- for why `academy`/`platform` audiences have no writer here).
CREATE POLICY "announcements_manage_select" ON "announcements"
  FOR SELECT
  USING (
    "announcements"."course_id" IS NOT NULL
    AND is_course_moderator("announcements"."course_id", current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_manage_insert" ON "announcements"
  FOR INSERT
  WITH CHECK (
    "announcements"."course_id" IS NOT NULL
    AND is_course_moderator("announcements"."course_id", current_setting('app.current_user_id', true))
  );

CREATE POLICY "announcements_manage_update" ON "announcements"
  FOR UPDATE
  USING (
    "announcements"."course_id" IS NOT NULL
    AND is_course_moderator("announcements"."course_id", current_setting('app.current_user_id', true))
  )
  WITH CHECK (
    "announcements"."course_id" IS NOT NULL
    AND is_course_moderator("announcements"."course_id", current_setting('app.current_user_id', true))
  );

ALTER TABLE "blog_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "blog_posts" FORCE ROW LEVEL SECURITY;

-- Published posts: platform-level (no academy) visible to everyone;
-- academy-level visible to any real academy member.
CREATE POLICY "blog_posts_published_select" ON "blog_posts"
  FOR SELECT
  USING (
    "blog_posts"."status" = 'published'
    AND (
      "blog_posts"."academy_id" IS NULL
      OR is_academy_member("blog_posts"."academy_id", current_setting('app.current_user_id', true))
    )
  );

-- "Plus their own drafts" (`BlogService.getPosts`'s own doc comment) —
-- the author sees every status of their own post.
CREATE POLICY "blog_posts_author_select" ON "blog_posts"
  FOR SELECT
  USING ("blog_posts"."author_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "blog_posts_author_insert" ON "blog_posts"
  FOR INSERT
  WITH CHECK ("blog_posts"."author_id"::text = current_setting('app.current_user_id', true));

-- "Updates/Publishes/Archives/Deletes a post the current user owns" —
-- `BlogService`'s own doc comments, verbatim: narrower than
-- `announcements` deliberately — no academy-staff override here, only the
-- real author.
CREATE POLICY "blog_posts_author_update" ON "blog_posts"
  FOR UPDATE
  USING ("blog_posts"."author_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("blog_posts"."author_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "blog_posts_author_delete" ON "blog_posts"
  FOR DELETE
  USING ("blog_posts"."author_id"::text = current_setting('app.current_user_id', true));

ALTER TABLE "forums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forums" FORCE ROW LEVEL SECURITY;

CREATE POLICY "forums_participant_select" ON "forums"
  FOR SELECT
  USING (is_course_participant("forums"."course_id", current_setting('app.current_user_id', true)));

-- No create endpoint in `ForumService` — a course's forum is get-or-created
-- lazily by any real participant on first legitimate access (see
-- schema.prisma's `Forum` doc comment), so INSERT reuses the identical
-- participant check.
CREATE POLICY "forums_participant_insert" ON "forums"
  FOR INSERT
  WITH CHECK (is_course_participant("forums"."course_id", current_setting('app.current_user_id', true)));

ALTER TABLE "forum_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forum_threads" FORCE ROW LEVEL SECURITY;

CREATE POLICY "forum_threads_participant_select" ON "forum_threads"
  FOR SELECT
  USING (is_course_participant("forum_threads"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "forum_threads_participant_insert" ON "forum_threads"
  FOR INSERT
  WITH CHECK (
    "forum_threads"."author_id"::text = current_setting('app.current_user_id', true)
    AND is_course_participant("forum_threads"."course_id", current_setting('app.current_user_id', true))
  );

-- Pin/unpin/lock/unlock only (no general thread edit in `ForumService`) —
-- "Requires forum moderation authorization" (the service's own doc
-- comments).
CREATE POLICY "forum_threads_moderate_update" ON "forum_threads"
  FOR UPDATE
  USING (is_course_moderator("forum_threads"."course_id", current_setting('app.current_user_id', true)))
  WITH CHECK (is_course_moderator("forum_threads"."course_id", current_setting('app.current_user_id', true)));

ALTER TABLE "forum_replies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "forum_replies" FORCE ROW LEVEL SECURITY;

CREATE POLICY "forum_replies_participant_select" ON "forum_replies"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "forum_threads" t
      WHERE t."id" = "forum_replies"."thread_id"
        AND is_course_participant(t."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "forum_replies_participant_insert" ON "forum_replies"
  FOR INSERT
  WITH CHECK (
    "forum_replies"."author_id"::text = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM "forum_threads" t
      WHERE t."id" = "forum_replies"."thread_id"
        AND t."locked" = false
        AND is_course_participant(t."course_id", current_setting('app.current_user_id', true))
    )
  );

-- ---------------------------------------------------------------------------
-- PART 3 — additive `is_course_instructor`/`is_course_participant`-keyed
-- policies on pre-existing P5/P6 tables, so `InstructorService` (running
-- entirely under `app.current_user_id`) can resolve teaching scope and
-- read/grade real student data. Every policy below is additive (Postgres
-- ORs multiple SELECT/UPDATE policies together) — none replaces or
-- narrows the existing P5 org-scoped or P6 enrollment-scoped policy on
-- these tables. `course_instructors` itself stays untouched beyond its
-- Part 1 self-select addition — still no INSERT/UPDATE/DELETE policy at
-- all (P5's original, unrevised) — P7 only ever reads it, matching master
-- plan §24's audited "resolves teaching scope from it, never writes it"
-- rule to the letter.
-- ---------------------------------------------------------------------------

CREATE POLICY "courses_instructor_select" ON "courses"
  FOR SELECT
  USING (is_course_instructor("courses"."id", current_setting('app.current_user_id', true)));

-- Broader than instructor-only — needed for `AnnouncementsService`'s
-- manage-authorization read and `ForumsService`'s get-or-create read (any
-- real academy staff member is a legitimate participant, not just
-- instructors). Mirrors the existing P5 `courses_tenant_select`'s own "any
-- organization member may read" shape, applied to the user-context code
-- path.
CREATE POLICY "courses_academy_participant_select" ON "courses"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academy_members" am
      WHERE am."academy_id" = "courses"."academy_id"
        AND am."user_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "course_sections_instructor_select" ON "course_sections"
  FOR SELECT
  USING (is_course_instructor("course_sections"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "course_lessons_instructor_select" ON "course_lessons"
  FOR SELECT
  USING (is_course_instructor("course_lessons"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quizzes_instructor_select" ON "quizzes"
  FOR SELECT
  USING (is_course_instructor("quizzes"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_instructor_select" ON "quiz_questions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND is_course_instructor(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_question_options_instructor_select" ON "quiz_question_options"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND is_course_instructor(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "assignments_instructor_select" ON "assignments"
  FOR SELECT
  USING (is_course_instructor("assignments"."course_id", current_setting('app.current_user_id', true)));

-- Roster reads: every enrolled student of a course this user teaches.
CREATE POLICY "enrollments_instructor_select" ON "enrollments"
  FOR SELECT
  USING (is_course_instructor("enrollments"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "course_progress_instructor_select" ON "course_progress"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND is_course_instructor(e."course_id", current_setting('app.current_user_id', true))
    )
  );

-- Every student's attempts at a quiz belonging to a course this user
-- teaches (`InstructorService.getQuizAttempts`) — read-only, an instructor
-- never grades a quiz attempt (auto-scored, P6, unchanged).
CREATE POLICY "quiz_attempts_instructor_select" ON "quiz_attempts"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_attempts"."quiz_id"
        AND is_course_instructor(q."course_id", current_setting('app.current_user_id', true))
    )
  );

-- Submission review + the one real P7 write: grading
-- (`InstructorService.gradeSubmission`, writing only
-- `grading_status`/`score`/`feedback`/`graded_at`/`graded_by` — enforced at
-- the DTO/service layer, RLS governs rows, not columns).
CREATE POLICY "assignment_submissions_instructor_select" ON "assignment_submissions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND is_course_instructor(a."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "assignment_submissions_instructor_update" ON "assignment_submissions"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND is_course_instructor(a."course_id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "assignments" a
      WHERE a."id" = "assignment_submissions"."assignment_id"
        AND is_course_instructor(a."course_id", current_setting('app.current_user_id', true))
    )
  );
