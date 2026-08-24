-- ============================================================================
-- P3 follow-up (no schema diff — hand-written RLS only, mirroring the
-- pattern already established by `20260823182500_p2_self_membership_rls_policies`
-- and `20260823183500_p2_app_role_rls_enforcement`).
--
-- Two additions:
--
-- 1. `academies_org_member_select` — a user-scoped bootstrap policy, additive
--    to the existing `academies_tenant_select`. Needed because the
--    `academies/:id/*` route group (master plan §10) resolves tenant
--    ownership TRANSITIVELY: the caller supplies only an academy id, never
--    an organization id, so nothing can call `runInTenantContext` yet — the
--    organization id being sought is itself a column on the very row RLS is
--    protecting (chicken-and-egg). The fix mirrors P2's own
--    `organizations_member_select` exactly: resolve it once via
--    `runInUserContext` (`app.current_user_id`, no organization context
--    needed), scoped to organizations the caller actually belongs to. Once
--    that bootstrap read succeeds, the row's own `organization_id` column is
--    plainly readable (RLS gates ROWS, not columns) — the application layer
--    (`AcademyScopeGuard`) then re-establishes a real `runInTenantContext`
--    with that id and re-reads everything through the normal tenant-scoped
--    policy, exactly matching `OrganizationsService.getById`'s own
--    documented "independently re-establish, never trust the guard's read"
--    discipline. This does not weaken tenant isolation — a user still can
--    never resolve an academy belonging to an organization they have no
--    membership in, under either policy (Postgres OR-combines permissive
--    policies).
--
--    Read access to an Academy (list, detail, members, stats, activity) is
--    governed by ORGANIZATION membership, not a separate academy_members
--    gate — matching the frontend's own `getAcademies` doc comment
--    ("Retrieves all academies for the ACTIVE ORGANIZATION"), and consistent
--    with P2's precedent of not inventing a narrower visibility rule than
--    the frontend contract asks for. `academy_members`-based role checks
--    (owner/administrator required) are enforced at the service layer for
--    WRITE operations only (create/update/branding/archive) — see
--    `AcademiesService` — which is exactly the case the master plan's "do
--    not assume organization owner = automatic unrestricted Academy Owner"
--    instruction is about: an org membership is sufficient to READ, never
--    assumed sufficient to WRITE.
--
-- 2. `academies_tenant_update` — P3 is the migration that adds the actual
--    UPDATE capability (`PATCH /academies/:id`, `PATCH
--    /academies/:id/branding`, and `DELETE /academies/:id`'s archive-via-
--    status-update), so per §17 ("policy lands with the capability") the
--    UPDATE policy is added now, not deferred. Both `USING` and `WITH CHECK`
--    require `organization_id` to match the active tenant context — this is
--    what makes it structurally impossible for an UPDATE statement to
--    reassign `organization_id` to a different organization: the session's
--    tenant context is fixed for the whole transaction, so a row can never
--    simultaneously satisfy `USING` under one org and `WITH CHECK` under
--    another. No UPDATE policy is added for `academy_members` — P3 defines
--    no role-change/status-change endpoint for academy members at all.
-- ============================================================================

CREATE POLICY "academies_org_member_select" ON "academies"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "organization_memberships" om
      WHERE om."organization_id" = "academies"."organization_id"
        AND om."user_id"::text = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY "academies_tenant_update" ON "academies"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
