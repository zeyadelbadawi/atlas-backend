-- ============================================================================
-- P20: Organization Manager — grant-membership-to-another-user INSERT policy.
--
-- `organization_memberships_insert` (added in the P2 narrowing migration,
-- `20260823184500_p2_narrow_insert_rls_policies`) only ever permitted a
-- caller to insert a membership row for THEMSELVES
-- (`user_id = app.current_user_id`). That closed the "grant someone else a
-- membership/role" privilege-escalation vector entirely, which was correct
-- at the time — no endpoint needed the opposite capability yet.
--
-- `AcademiesService.addManager` (`POST /academies/:id/members`) is the
-- first legitimate case that does: an Organization Owner adding an
-- already-registered Atlas user as that organization's Manager, so the
-- backend's academy-role-based `MANAGING_ROLES` check and the frontend's
-- org-permission-based `RouteGuard` both recognize them. Postgres RLS
-- evaluates multiple permissive policies for the same command with OR
-- semantics, so this is a pure ADDITION — the existing self-insert policy
-- is untouched, and self-insert (organization bootstrap) keeps working
-- exactly as before.
--
-- The new policy is scoped as narrowly as the capability actually needs:
-- permitted only when the target organization's `owner_user_id` equals the
-- CALLER's own verified id (`app.current_user_id`) — i.e. only the real
-- Organization Owner may grant anyone else a membership row, never a
-- Manager granting further memberships, and never for an organization the
-- caller does not own. `AcademiesService.addManager` additionally
-- re-verifies this same fact at the service layer (defense in depth, the
-- same "RLS is the primary defense, not a backstop, but never the ONLY
-- defense" posture every prior migration in this file's family documents)
-- before ever reaching this INSERT, so a mismatch fails with a clean
-- `ForbiddenException`, not a raw RLS-denial database error.
-- ============================================================================

CREATE POLICY "organization_memberships_owner_grants_insert" ON "organization_memberships"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."id" = "organization_memberships"."organization_id"
        AND o."owner_user_id"::text = current_setting('app.current_user_id', true)
    )
  );
