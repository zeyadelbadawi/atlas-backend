-- ============================================================================
-- P64 Phase 1 — CORRECTION to `20261008000000_p64_phase1_identity_rbac_foundation`.
--
-- That migration added tenant-scoped INSERT/UPDATE policies on `enrollments`
-- (and INSERT on the two progress tables) so staff can enroll a student
-- manually. They were too wide: a STUDENT's own enrollment also runs under
-- `runInTenantAndUserContext` (the entitlement check needs the tenant
-- context), so "the academy belongs to the current organization" was true
-- for the student too — and a `pending`/blocked student could insert an
-- enrollment the `enrollments_self_insert` policy would have refused.
-- Reproduced by the P64 e2e suite ("an APPROVAL academy ... refuses access
-- until approved"), which failed with 201 instead of 403.
--
-- The staff policies now additionally require the ACTING USER to be an
-- active owner/administrator/manager of the owning academy — the same rule
-- `AcademyStudentsService.assertCanManageStudents` applies in the
-- application layer.
-- ============================================================================

CREATE OR REPLACE FUNCTION can_manage_academy_students(p_academy_id text, p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "academy_members" am
    WHERE am."academy_id" = p_academy_id
      AND am."user_id" = p_user_id
      AND am."status" = 'active'
      AND am."role" IN ('owner', 'administrator', 'manager')
  );
$$;

DROP POLICY IF EXISTS "enrollments_tenant_insert" ON "enrollments";
CREATE POLICY "enrollments_staff_insert" ON "enrollments"
  FOR INSERT
  WITH CHECK (
    can_manage_academy_students(
      "enrollments"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS "enrollments_tenant_update" ON "enrollments";
CREATE POLICY "enrollments_staff_update" ON "enrollments"
  FOR UPDATE
  USING (
    can_manage_academy_students(
      "enrollments"."academy_id",
      current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    can_manage_academy_students(
      "enrollments"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS "course_progress_tenant_insert" ON "course_progress";
CREATE POLICY "course_progress_staff_insert" ON "course_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "course_progress"."enrollment_id"
        AND can_manage_academy_students(
          e."academy_id",
          current_setting('app.current_user_id', true)
        )
    )
  );

DROP POLICY IF EXISTS "lesson_progress_tenant_insert" ON "lesson_progress";
CREATE POLICY "lesson_progress_staff_insert" ON "lesson_progress"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."id" = "lesson_progress"."enrollment_id"
        AND can_manage_academy_students(
          e."academy_id",
          current_setting('app.current_user_id', true)
        )
    )
  );

-- The two tenant SELECT policies stay as they are: reading a roster's
-- progress inside an organization context is exactly what the staff
-- dashboards do, and the application layer gates who may open that
-- context. Students read their own rows through the `*_self_select`
-- policies, unchanged.

-- `academy_students_tenant_update` (block/unblock/approve) gets the same
-- treatment: a student must never be able to edit their own membership row
-- just because a tenant context happens to be open.
DROP POLICY IF EXISTS "academy_students_tenant_update" ON "academy_students";
CREATE POLICY "academy_students_staff_update" ON "academy_students"
  FOR UPDATE
  USING (
    can_manage_academy_students(
      "academy_students"."academy_id",
      current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    can_manage_academy_students(
      "academy_students"."academy_id",
      current_setting('app.current_user_id', true)
    )
  );
