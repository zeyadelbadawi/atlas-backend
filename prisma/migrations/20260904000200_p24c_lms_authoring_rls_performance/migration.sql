-- ============================================================================
-- P24c — RLS performance fix for `quiz_questions`/`quiz_question_options`
-- (master plan §22/§24, Phase 4 follow-up #2).
--
-- Discovered during implementation via direct query-timing instrumentation
-- (mirroring exactly how P7's own header comment documents discovering its
-- analogous Community/forum finding): `QuizzesRepository.create`'s nested
-- `include: { questions: { include: { options: true } } }` read-back —
-- and the equivalent `findAnyByIdWithQuestions` authoring read — measured
-- at 3.5+ seconds for a single question with two options, entirely inside
-- one already-fast-everywhere-else transaction (every other step in the
-- same transaction profiled under 200ms). Root cause is IDENTICAL in
-- shape to P7's own documented finding for `forum_replies` (that
-- migration's own header comment, verbatim: "a plain nested `EXISTS`
-- chain forces Postgres to re-evaluate a full OR'd policy set at every
-- join level, compounding into multi-second query times even against a
-- handful of rows"): the P24/P24b `quiz_questions_author_*`/
-- `quiz_question_options_author_*` policies (and, it turns out, the
-- pre-existing P6 `*_enrolled_select`/P7 `*_instructor_select` policies
-- on these same two tables) all express "is this row's owning quiz
-- accessible" as `EXISTS (SELECT 1 FROM "quizzes" ...)` — a real SELECT
-- against `quizzes`, itself a FORCE ROW LEVEL SECURITY table, which
-- re-triggers `quizzes`' own full policy set on every evaluation,
-- compounding across two nesting levels (question -> quiz,
-- option -> question -> quiz) and now three alternative policies per
-- level (enrolled, instructor, author) instead of P7's original two.
--
-- Fix, applying P7's own established pattern (never re-invented): two new
-- narrowly-scoped `SECURITY DEFINER` functions that resolve "is this
-- quiz/question's owning quiz authorable-or-readable" via a DIRECT,
-- RLS-bypassing lookup chain — never a real `SELECT ... FROM quizzes`
-- subquery evaluated under the CALLER's own RLS context. Every existing
-- policy on `quiz_questions`/`quiz_question_options` is replaced
-- (DROP + CREATE) with an equivalent, behavior-IDENTICAL policy built on
-- these functions — same rows visible/writable to the same callers as
-- before, only the SQL machinery changes. `quizzes`/`assignments`
-- themselves are untouched — their own SELECT policies already reference
-- no other FORCE RLS table, so they were never part of this compounding
-- and remain exactly as P24/P24b/P6/P7 left them.
-- ============================================================================

CREATE FUNCTION can_access_quiz(p_quiz_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "quizzes" q
      JOIN "enrollments" e ON e."course_id" = q."course_id"
      WHERE q."id" = p_quiz_id
        AND e."student_id" = p_user_id
        AND e."status" IN ('enrolled', 'completed')
    )
    OR EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = p_quiz_id
        AND is_course_instructor(q."course_id", p_user_id)
    )
    OR EXISTS (
      SELECT 1 FROM "quizzes" q
      WHERE q."id" = p_quiz_id
        AND can_author_course_content(q."course_id", p_user_id)
    );
$$;

CREATE FUNCTION can_write_quiz(p_quiz_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT can_author_course_content(q."course_id", p_user_id)
  FROM "quizzes" q
  WHERE q."id" = p_quiz_id;
$$;

CREATE FUNCTION can_access_quiz_question(p_question_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT can_access_quiz(qq."quiz_id", p_user_id)
  FROM "quiz_questions" qq
  WHERE qq."id" = p_question_id;
$$;

CREATE FUNCTION can_write_quiz_question(p_question_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT can_write_quiz(qq."quiz_id", p_user_id)
  FROM "quiz_questions" qq
  WHERE qq."id" = p_question_id;
$$;

-- ---------------------------------------------------------------------------
-- quiz_questions — replace every existing policy with the function-based
-- equivalent (identical access outcome, no recursive RLS re-evaluation).
-- ---------------------------------------------------------------------------

DROP POLICY "quiz_questions_enrolled_select" ON "quiz_questions";
DROP POLICY "quiz_questions_instructor_select" ON "quiz_questions";
DROP POLICY "quiz_questions_author_select" ON "quiz_questions";
DROP POLICY "quiz_questions_author_insert" ON "quiz_questions";
DROP POLICY "quiz_questions_author_update" ON "quiz_questions";
DROP POLICY "quiz_questions_author_delete" ON "quiz_questions";

CREATE POLICY "quiz_questions_access_select" ON "quiz_questions"
  FOR SELECT
  USING (can_access_quiz_question("quiz_questions"."id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_insert" ON "quiz_questions"
  FOR INSERT
  WITH CHECK (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_update" ON "quiz_questions"
  FOR UPDATE
  USING (can_write_quiz_question("quiz_questions"."id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_delete" ON "quiz_questions"
  FOR DELETE
  USING (can_write_quiz_question("quiz_questions"."id", current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- quiz_question_options — same treatment, one level deeper.
-- ---------------------------------------------------------------------------

DROP POLICY "quiz_question_options_enrolled_select" ON "quiz_question_options";
DROP POLICY "quiz_question_options_instructor_select" ON "quiz_question_options";
DROP POLICY "quiz_question_options_author_select" ON "quiz_question_options";
DROP POLICY "quiz_question_options_author_insert" ON "quiz_question_options";
DROP POLICY "quiz_question_options_author_update" ON "quiz_question_options";
DROP POLICY "quiz_question_options_author_delete" ON "quiz_question_options";

CREATE POLICY "quiz_question_options_access_select" ON "quiz_question_options"
  FOR SELECT
  USING (can_access_quiz_question("quiz_question_options"."question_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_question_options_author_insert" ON "quiz_question_options"
  FOR INSERT
  WITH CHECK (can_write_quiz_question("quiz_question_options"."question_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_question_options_author_update" ON "quiz_question_options"
  FOR UPDATE
  USING (can_write_quiz_question("quiz_question_options"."question_id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_write_quiz_question("quiz_question_options"."question_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_question_options_author_delete" ON "quiz_question_options"
  FOR DELETE
  USING (can_write_quiz_question("quiz_question_options"."question_id", current_setting('app.current_user_id', true)));
