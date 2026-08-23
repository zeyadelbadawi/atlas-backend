-- ============================================================================
-- P2 correction: the prior migration's INSERT policies
-- (`organizations_insert`, `organization_memberships_insert`) used
-- `WITH CHECK (true)` — unconditionally permissive. On review this fails
-- master plan §7's "RLS is the primary defense, not a backstop" and §16's
-- security posture: under the `atlas_app` runtime role (the same role
-- every request uses), `WITH CHECK (true)` provided no protection at all
-- against a bug or an unreviewed code path inserting a membership row for
-- an arbitrary user in an arbitrary organization (a full membership-
-- injection / privilege-escalation vector), or an organization row with an
-- arbitrary `owner_user_id`. No P2 endpoint currently performs either
-- INSERT — but the RLS policy governs the role, not the endpoint, so
-- "nothing calls it today" was never a valid justification for a
-- unconditionally-open policy.
--
-- Replaced with the narrowest policy that still permits the one legitimate
-- case within reach: a user creating an organization/membership for
-- THEMSELVES.
--
--   organizations_insert — permitted only when the new row's
--     `owner_user_id` equals the caller's own verified id
--     (`app.current_user_id`, set by `TenancyContextService`, never
--     client-supplied). A caller can create an organization they own;
--     never one "owned" by anyone else.
--
--   organization_memberships_insert — permitted only when BOTH:
--     (a) the new row's `user_id` equals the caller's own verified id
--         (closes the "grant someone else a membership/role" vector
--         entirely — this is the more severe of the two original gaps),
--         and
--     (b) the target organization's `owner_user_id` also equals the
--         caller's own verified id (closes "join/self-elevate into an
--         organization you don't own"). The EXISTS subquery is itself
--         subject to `organizations`' own RLS policies — it can only see
--         the target row if the organization is already visible under the
--         active tenant/user context, which in practice means a future
--         org-creation flow (Phase P14 provisioning — out of P2's scope)
--         must establish both `app.current_organization_id` (set to the
--         new org's own, pre-generated id) and `app.current_user_id`
--         together for the bootstrap owner-membership insert to satisfy
--         this check. P2 itself never exercises this path — see the P2
--         final report for how test fixtures are seeded instead (a
--         dedicated superuser connection, outside the runtime role this
--         policy governs).
-- ============================================================================

DROP POLICY "organizations_insert" ON "organizations";
DROP POLICY "organization_memberships_insert" ON "organization_memberships";

CREATE POLICY "organizations_insert" ON "organizations"
  FOR INSERT
  WITH CHECK ("owner_user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "organization_memberships_insert" ON "organization_memberships"
  FOR INSERT
  WITH CHECK (
    "user_id"::text = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o."id" = "organization_memberships"."organization_id"
        AND o."owner_user_id"::text = current_setting('app.current_user_id', true)
    )
  );
