-- ============================================================================
-- P64 Phase 1 — CORRECTION to `courses_enrolled_student_select`
-- (`20261008000600`), on cost rather than correctness.
--
-- The tier was written as an inline
--   EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = courses.id
--           AND e.student_id = current_setting('app.current_user_id', true))
-- which is correct — a student sees only their own enrollment rows — but
-- expensive in a way that only shows up at volume, because that subquery
-- runs as the INVOKING role and therefore evaluates all eleven RLS
-- policies on `enrollments` ONCE PER CANDIDATE COURSE ROW.
--
-- Measured on a local database carrying ~2,400 published public courses
-- (accumulated e2e data), through the pre-existing
-- `course_categories_public_discovery_select` policy, which itself runs a
-- correlated EXISTS over `courses`:
--
--   without this tier at all           2,319 ms
--   with the inline-EXISTS tier        3,658 ms   (+58%)
--
-- The same lesson as `20261008000400`: a policy predicate that has to
-- cross into another table belongs in a SECURITY DEFINER function, which
-- answers the structural question with one indexed lookup and evaluates
-- no policies of its own. The function grants NO row visibility — it
-- returns a boolean about the caller's OWN enrollment and nothing else,
-- and it is keyed on the caller id the policy passes in, never on
-- anything a caller can spoof.
--
-- The lookup hits `enrollments_student_id_course_id_key`
-- (UNIQUE (student_id, course_id)) as an equality match on both columns.
--
-- Semantics are unchanged from `20261008000600`: any enrollment the
-- student holds — including revoked, expired and completed — still makes
-- the course row itself visible, so their own list can render the state.
-- Course CONTENT tiers are untouched.
-- ============================================================================

CREATE OR REPLACE FUNCTION is_enrolled_in_course(p_course_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "enrollments" e
    WHERE e."student_id" = p_user_id
      AND e."course_id" = p_course_id
  );
$$;

DROP POLICY IF EXISTS "courses_enrolled_student_select" ON "courses";
CREATE POLICY "courses_enrolled_student_select" ON "courses"
  FOR SELECT
  USING (
    current_setting('app.current_user_id', true) IS NOT NULL
    AND current_setting('app.current_user_id', true) <> ''
    AND is_enrolled_in_course("courses"."id", current_setting('app.current_user_id', true))
  );
