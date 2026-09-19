-- ============================================================================
-- P64 Phase 1 — `quizzes_tenant_select`.
--
-- The owner/manager analytics read (`StudentAnalyticsRepository.
-- findQuizOutcomes`) filters attempts through the RELATION
-- `quiz: { course: { academy: { organizationId } } }`. Prisma resolves that
-- by joining `quizzes` and `courses`, both of which are subject to RLS for
-- the caller. `courses` has had a tenant-scoped SELECT policy since P5;
-- `quizzes` never did — its only read tiers are enrolled student, course
-- author and course instructor. Under the tenant-only context the analytics
-- service opens, the join therefore matched nothing and the "failing quiz"
-- at-risk signal could never fire (reproduced against the real database:
-- `atRiskStudents: []` for a student with a real failed attempt).
--
-- This adds the missing tier, scoped exactly like `courses_tenant_select`
-- and resolved through the `quiz_belongs_to_organization` SECURITY DEFINER
-- helper so the policy does not itself depend on row visibility. It grants
-- staff of the owning organization read access to their own academies'
-- quiz DEFINITIONS — never to attempts (those keep their own policies) and
-- never across tenants.
-- ============================================================================

CREATE POLICY "quizzes_tenant_select" ON "quizzes"
  FOR SELECT
  USING (
    current_setting('app.current_organization_id', true) IS NOT NULL
    AND current_setting('app.current_organization_id', true) <> ''
    AND quiz_belongs_to_organization(
      "quizzes"."id",
      current_setting('app.current_organization_id', true)
    )
  );
