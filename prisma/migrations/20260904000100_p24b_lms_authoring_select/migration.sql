-- ============================================================================
-- P24b — the missing author-facing SELECT policies on `quizzes`/
-- `quiz_questions`/`quiz_question_options`/`assignments` (master plan
-- §22/§24, Phase 4 follow-up).
--
-- Discovered during implementation, not designed up front (the exact same
-- shape of gap Phase 2 found for `enrollments_tenant_select` and Phase 3
-- found for `course_instructors_tenant_delete`): the P24 migration added
-- real INSERT/UPDATE/DELETE policies gated by `can_author_course_content`
-- (course instructor, OR the owning academy's owner/administrator/
-- manager), but every PRE-EXISTING SELECT policy on these four tables
-- (`*_enrolled_select`, `*_instructor_select`) was written for the P6/P7
-- student-and-instructor READ model and admits neither an Owner nor an
-- Administrator nor a Manager. PostgreSQL RLS requires a matching SELECT
-- policy for TWO things a plain "can write" check does not cover on its
-- own: (1) `INSERT ... RETURNING`/`UPDATE ... RETURNING` — which Prisma's
-- query engine always uses to hand the created/updated row back to the
-- caller — fails outright ("new row violates row-level security policy")
-- without one, even when the INSERT/UPDATE's own WITH CHECK genuinely
-- passed; (2) the new authoring GET endpoints
-- (`getQuizForAuthoring`/`getAssignmentForAuthoring`/the two authoring
-- list endpoints) would otherwise silently return nothing to an Owner/
-- Administrator/Manager, exactly the same "RLS-empty result" failure mode
-- `assertCourseReadAccess`'s own doc comment already warns this class of
-- mismatch produces.
--
-- Purely additive — every existing policy on these four tables is
-- unchanged; multiple permissive SELECT policies on the same table
-- combine with OR, so a student/instructor who could already read these
-- rows is completely unaffected.
-- ============================================================================

CREATE POLICY "quizzes_author_select" ON "quizzes"
  FOR SELECT
  USING (can_author_course_content("quizzes"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_select" ON "quiz_questions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_question_options_author_select" ON "quiz_question_options"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "assignments_author_select" ON "assignments"
  FOR SELECT
  USING (can_author_course_content("assignments"."course_id", current_setting('app.current_user_id', true)));
