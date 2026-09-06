-- ============================================================================
-- P24d — fixes a genuine `INSERT ... RETURNING` RLS bug on `quiz_questions`
-- introduced by P24c (Phase 4 follow-up #3).
--
-- Discovered via direct, isolated SQL reproduction (bypassing Prisma
-- entirely to rule out an ORM-layer cause): `quiz_questions`' P24c
-- policies used `can_access_quiz_question("quiz_questions"."id", ...)`/
-- `can_write_quiz_question("quiz_questions"."id", ...)` — functions that
-- SELF-REFERENTIALLY re-query `quiz_questions` (the SAME table the
-- policy protects) by id to resolve `quiz_id`, rather than reading the
-- row's own `quiz_id` column directly. For a plain SELECT against an
-- already-committed row this self-lookup works fine (confirmed by direct
-- testing) — but for `INSERT ... RETURNING` (which Prisma's query engine
-- always uses), PostgreSQL evaluates the RETURNING SELECT-policy using
-- the row data from the INSERT itself; a SECURITY DEFINER function that
-- instead issues a FRESH, separate lookup of that same table by id
-- inside the same command does not reliably see that not-yet-externally-
-- visible row, so the check spuriously fails with "new row violates row-
-- level security policy" even though `can_access_quiz_question`/
-- `can_write_quiz_question`, called directly against an already-existing
-- row, correctly return true.
--
-- Fix: `quiz_questions`' own policies now call `can_access_quiz`/
-- `can_write_quiz` directly on the row's own `quiz_id` COLUMN — no
-- self-referential re-query of `quiz_questions` at all, matching how
-- every other policy in this codebase (and P24c's own
-- `quiz_question_options` policies, confirmed safe by the same direct
-- testing — they resolve through the DIFFERENT `quiz_questions` table,
-- never re-querying their own `quiz_question_options` table) already
-- reads the row's own foreign-key column rather than re-selecting the
-- row itself. `can_access_quiz_question`/`can_write_quiz_question`
-- (P24c) are kept, unmodified — they remain correct and necessary for
-- `quiz_question_options`, one level further down, which never hits this
-- self-reference shape.
-- ============================================================================

DROP POLICY "quiz_questions_access_select" ON "quiz_questions";
DROP POLICY "quiz_questions_author_insert" ON "quiz_questions";
DROP POLICY "quiz_questions_author_update" ON "quiz_questions";
DROP POLICY "quiz_questions_author_delete" ON "quiz_questions";

CREATE POLICY "quiz_questions_access_select" ON "quiz_questions"
  FOR SELECT
  USING (can_access_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_insert" ON "quiz_questions"
  FOR INSERT
  WITH CHECK (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_update" ON "quiz_questions"
  FOR UPDATE
  USING (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)))
  WITH CHECK (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));

CREATE POLICY "quiz_questions_author_delete" ON "quiz_questions"
  FOR DELETE
  USING (can_write_quiz("quiz_questions"."quiz_id", current_setting('app.current_user_id', true)));
