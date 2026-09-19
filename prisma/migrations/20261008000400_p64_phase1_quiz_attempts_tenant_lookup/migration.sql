-- ============================================================================
-- P64 Phase 1 — CORRECTION to `quiz_attempts_tenant_select`
-- (`20261008000000_p64_phase1_identity_rbac_foundation`).
--
-- The policy resolved the attempt's owning organization with an inline
-- `EXISTS (SELECT ... FROM quizzes JOIN courses JOIN academies ...)`. That
-- subquery runs as the INVOKING role, so it is itself subject to RLS on
-- `quizzes`/`courses`/`academies`. `quizzes` has no tenant-scoped SELECT
-- policy at all (only enrolled/author/instructor tiers), so the policy's
-- correctness depended on which OTHER policy happened to make a quiz
-- visible to the caller — a condition that is true for an academy owner
-- today and could silently stop being true later, taking the owner
-- analytics "failing quiz" signal with it.
--
-- The lookup now goes through a SECURITY DEFINER function, exactly like
-- `is_course_instructor`/`can_author_course_content`, so it sees the
-- structural fact it needs regardless of the caller's row visibility, and
-- grants no row visibility of its own.
-- ============================================================================

CREATE OR REPLACE FUNCTION quiz_belongs_to_organization(p_quiz_id text, p_organization_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "quizzes" q
    JOIN "courses" c ON c."id" = q."course_id"
    JOIN "academies" a ON a."id" = c."academy_id"
    WHERE q."id" = p_quiz_id
      AND a."organization_id" = p_organization_id
  );
$$;

DROP POLICY IF EXISTS "quiz_attempts_tenant_select" ON "quiz_attempts";
CREATE POLICY "quiz_attempts_tenant_select" ON "quiz_attempts"
  FOR SELECT
  USING (
    current_setting('app.current_organization_id', true) IS NOT NULL
    AND current_setting('app.current_organization_id', true) <> ''
    AND quiz_belongs_to_organization(
      "quiz_attempts"."quiz_id",
      current_setting('app.current_organization_id', true)
    )
  );
