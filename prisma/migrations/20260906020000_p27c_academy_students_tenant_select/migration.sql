-- ============================================================================
-- P27c — fixes a real gap found while testing the new Phase 6 public
-- statistics endpoint (`GET public/websites/:academyId/statistics`).
--
-- `academy_students` (P21) only ever had TWO SELECT policies:
-- `academy_students_self_select` (the student's own row) and
-- `academy_students_staff_select` (`is_academy_member`, a real staff
-- session) — both require `app.current_user_id` to be set. Unlike
-- `academy_members`, which already has `academy_members_tenant_select`
-- (P3) for exactly this "organization-tenant-context-only, no user"
-- read shape, `academy_students` had no equivalent — so
-- `AcademyStudentsRepository.countForAcademy`, called under a plain
-- `runInTenantContext` (no user context at all, matching every other
-- method on `PublicWebsiteService`), silently saw zero rows regardless of
-- the real count. Confirmed live: an e2e test seeding one real enrolled
-- student returned `students: 0` from the statistics endpoint before this
-- fix.
--
-- Additive only, mirrors `academy_members_tenant_select` exactly — never
-- replaces or narrows either existing `academy_students` SELECT policy.
-- ============================================================================

CREATE POLICY "academy_students_tenant_select" ON "academy_students"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_students"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
