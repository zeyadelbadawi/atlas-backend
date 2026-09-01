-- ============================================================================
-- P23 — Instructor <-> Course Assignment (master plan §22/§23, Phase 3).
--
-- The ONLY schema change this phase requires: `course_instructors` already
-- has everything the write path needs (composite PK, no ordering/rank
-- column — see `schema.prisma`'s `CourseInstructor` model, unchanged).
-- What it never had, because no endpoint ever wrote to it, is a DELETE RLS
-- policy: P5's migration explicitly documented "no DELETE policy on
-- ... course_instructors either — no endpoint deletes either" as a
-- deliberate, correct decision AT THE TIME. Phase 3 introduces the first
-- real DELETE endpoint (`CoursesService.removeInstructor`), so this table
-- would now silently no-op every DELETE under `FORCE ROW LEVEL SECURITY`
-- without one — not an error, a row that simply never disappears. This
-- migration adds exactly that one missing policy, in the same shape as
-- every sibling P5 tenant-scoped DELETE policy
-- (`course_sections_tenant_delete` / `course_lessons_tenant_delete`,
-- `20260824044819_p5_course_management/migration.sql`): a course is
-- reachable for DELETE on its `course_instructors` rows only when it
-- belongs to an academy owned by the caller's active organization context.
--
-- No other table, policy, or function changes. `is_course_instructor()`
-- (P7) is untouched — it already reads `course_instructors` directly and
-- needs no awareness of who can write to it.
-- ============================================================================

CREATE POLICY "course_instructors_tenant_delete" ON "course_instructors"
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "courses" c
      JOIN "academies" a ON a."id" = c."academy_id"
      WHERE c."id" = "course_instructors"."course_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
