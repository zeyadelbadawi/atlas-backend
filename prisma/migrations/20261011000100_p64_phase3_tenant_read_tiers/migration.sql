-- P64 Phase 3 — tenant-context READ tiers the completion evaluator needs.
--
-- Completion is recomputed after a reviewer grades (assignment or manual
-- quiz question) and after a reviewer voids an attempt. Those writes to
-- `course_progress`/`enrollments` run in the academy's TENANT context —
-- never as the learner, and the reviewer's user context has no UPDATE
-- tier on progress by design. The evaluator must therefore be able to
-- READ assignments and submissions under a tenant context, which Phase 1
-- never needed (assignments were read under user context only).
-- Additive SELECT tiers, scoped exactly like `quizzes_tenant_select`.

CREATE POLICY "assignments_tenant_select" ON "assignments"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "assignments"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "assignment_submissions_tenant_select" ON "assignment_submissions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "assignments" s
      JOIN "courses" c ON c."id" = s."course_id"
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE s."id" = "assignment_submissions"."assignment_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
