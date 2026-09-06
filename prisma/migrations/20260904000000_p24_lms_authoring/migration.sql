-- ============================================================================
-- P24 — LMS Completion: Quiz & Assignment Authoring (master plan §22/§24,
-- Phase 4).
--
-- `quizzes`/`quiz_questions`/`quiz_question_options`/`assignments` have
-- carried SELECT-only RLS since P6 (see schema.prisma's own P6 header
-- comment: "no write endpoint in P6"). Phase 4 introduces the first real
-- write path for all four tables — this migration adds exactly the
-- missing INSERT/UPDATE/DELETE policies, nothing else.
--
-- Authorization shape: mirrors `is_course_moderator` (P7) almost exactly
-- — "the course's real assigned instructor, OR the owning academy's
-- owner/administrator" — with one deliberate addition: `manager`. P7's
-- `is_course_moderator` was purpose-built for Community/forum moderation
-- and is left completely untouched (Community is out of this phase's
-- scope, and retrofitting its semantics for an unrelated purpose would be
-- exactly the kind of unnecessary existing-behavior change master plan
-- §24 warns against). Instead, a new, narrowly-scoped function is added:
-- `can_author_course_content`, matching `CoursesService.assertCanManage`'s
-- exact Owner/Administrator/Manager set (master plan §21 P5) PLUS the
-- course's own assigned instructor(s) — the precise rule master plan
-- §22/§24 states for quiz/assignment authoring: "an instructor may only
-- author content for courses they're assigned to; Owner/Manager retain
-- full Academy-wide authoring reach."
-- ============================================================================

CREATE FUNCTION can_author_course_content(p_course_id text, p_user_id text)
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
        AND am."role" IN ('owner', 'administrator', 'manager')
    );
$$;

-- ---------------------------------------------------------------------------
-- quizzes / quiz_questions / quiz_question_options
-- ---------------------------------------------------------------------------

CREATE POLICY "quizzes_author_insert" ON "quizzes"
  FOR INSERT
  WITH CHECK (can_author_course_content("quizzes"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quizzes_author_update" ON "quizzes"
  FOR UPDATE
  USING (can_author_course_content("quizzes"."course_id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_author_course_content("quizzes"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quizzes_author_delete" ON "quizzes"
  FOR DELETE
  USING (can_author_course_content("quizzes"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_insert" ON "quiz_questions"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_questions_author_update" ON "quiz_questions"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_questions_author_delete" ON "quiz_questions"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = "quiz_questions"."quiz_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_question_options_author_insert" ON "quiz_question_options"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_question_options_author_update" ON "quiz_question_options"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

CREATE POLICY "quiz_question_options_author_delete" ON "quiz_question_options"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "quiz_questions" qq
      JOIN "quizzes" q ON q."id" = qq."quiz_id"
      WHERE qq."id" = "quiz_question_options"."question_id"
        AND can_author_course_content(q."course_id", current_setting('app.current_user_id', true))
    )
  );

-- ---------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------

CREATE POLICY "assignments_author_insert" ON "assignments"
  FOR INSERT
  WITH CHECK (can_author_course_content("assignments"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "assignments_author_update" ON "assignments"
  FOR UPDATE
  USING (can_author_course_content("assignments"."course_id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_author_course_content("assignments"."course_id", current_setting('app.current_user_id', true)));

CREATE POLICY "assignments_author_delete" ON "assignments"
  FOR DELETE
  USING (can_author_course_content("assignments"."course_id", current_setting('app.current_user_id', true)));
