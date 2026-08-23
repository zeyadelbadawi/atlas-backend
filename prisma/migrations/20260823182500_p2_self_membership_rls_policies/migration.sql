-- ============================================================================
-- P2 follow-up: user-scoped RLS policies for "list my own organizations."
--
-- The prior migration's RLS policies scope SELECT on `organizations`/
-- `organization_memberships` to a SINGLE active tenant context
-- (`app.current_organization_id`). That's correct for every org-scoped
-- request (e.g. `GET /organizations/:id`), but `CurrentUser.organizations`/
-- `.organizationMemberships` (master plan §21 Phase P2, this phase's §20)
-- needs to list ALL organizations a user belongs to — a query that is
-- fundamentally scoped by USER, not by any single organization, and has no
-- "current org" to set at the point it runs (sign-in, `GET /users/me`).
--
-- Fix: a second session variable, `app.current_user_id`, set from the
-- verified JWT-authenticated user id (never client-supplied) via
-- `TenancyContextService.runInUserContext`. Postgres RLS combines multiple
-- permissive policies for the same command with OR, so these are additive
-- to (not a replacement for) the existing tenant-scoped policies: a row is
-- visible if it matches the active org context OR belongs to the caller's
-- own memberships. This does not weaken tenant isolation — a user still
-- can never see another user's membership row, or an organization they
-- have no membership in, under either policy.
-- ============================================================================

CREATE POLICY "organization_memberships_self_select" ON "organization_memberships"
  FOR SELECT
  USING ("user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "organizations_member_select" ON "organizations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "organization_memberships" om
      WHERE om."organization_id" = "organizations"."id"
        AND om."user_id"::text = current_setting('app.current_user_id', true)
    )
  );
