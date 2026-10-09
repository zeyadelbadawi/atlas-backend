-- Staff member removal — `DELETE /academies/:id/members/:userId`
-- (`AcademiesService.removeStaffMember`).
--
-- WHY THESE POLICIES ARE NEEDED. Atlas could add staff but never remove
-- them: `academy_members` had no UPDATE policy at all (P3 deliberately
-- defined none) and `organization_memberships` only a SELF delete (P38b,
-- account deletion). Without the policies below RLS would refuse — or, for
-- a DELETE, silently match zero rows and report success — exactly the
-- "looks like it worked" failure P38b documents.
--
-- WHO THEY ADMIT. Only the OWNER of the organization the row belongs to,
-- inside that organization's tenant context — the same person the P20
-- `organization_memberships_owner_grants_insert` policy alone lets grant
-- staff access. A Manager, an Administrator, an Instructor, or the owner of
-- another organization matches nothing. The service re-checks the same fact
-- first (`assertIsOrganizationOwner`), so a mismatch surfaces as a clean 403
-- rather than a raw RLS denial: two independent layers for one rule.
--
-- `current_setting(..., true)` is NULL without a context, and a comparison
-- with NULL is never true, so a context-free connection changes nothing.

-- 1. Marking an academy staff row `inactive` (and reactivating it when the
--    owner adds the person back).
CREATE POLICY "academy_members_owner_update" ON "academy_members"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      JOIN "organizations" o ON o."id" = a."organization_id"
      WHERE a."id" = "academy_members"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND o."owner_user_id"::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      JOIN "organizations" o ON o."id" = a."organization_id"
      WHERE a."id" = "academy_members"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND o."owner_user_id"::text = current_setting('app.current_user_id', true)
    )
  );

-- 2. Ending a removed staff member's organization membership once no
--    academy of the organization still needs it. Never an `owner` row and
--    never the organization owner's own row, whatever its role says.
CREATE POLICY "organization_memberships_owner_delete" ON "organization_memberships"
  FOR DELETE
  USING (
    "organization_id"::text = current_setting('app.current_organization_id', true)
    AND "role" <> 'owner'
    AND EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."id" = "organization_memberships"."organization_id"
        AND o."owner_user_id"::text = current_setting('app.current_user_id', true)
        AND o."owner_user_id"::text <> "organization_memberships"."user_id"::text
    )
  );

-- `course_instructors` already has a tenant-scoped DELETE policy
-- (`course_instructors_tenant_delete`, P23) and is deliberately untouched.
