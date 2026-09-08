-- Phase 8 follow-up — `audit_log_entries` had only ONE SELECT policy
-- before this migration: `audit_log_entries_platform_select`
-- (`is_platform_owner()`, P15). That is correct for the Platform Owner's
-- own audit-log page, but the new tenant-scoped dashboard's "recent
-- activity" widget (an Organization Owner reading their own
-- Organization's activity, or an Academy Manager reading their own
-- Academy's) has no existing RLS path to read this table at all — not an
-- oversight to route around at the application layer, a real missing
-- policy to add.
--
-- Deliberately ONE new policy, organization-scoped only (never a second,
-- academy-scoped policy): a Manager's dashboard narrows to their own
-- Academy via an ordinary `WHERE academy_id = :id` application-layer
-- filter (`DashboardService`, Phase 8) — that filter only ever runs with
-- an `academyId` `AcademyScopeGuard` already verified belongs to this
-- same organization, so no additional RLS predicate is needed to keep a
-- Manager inside their own organization's rows; RLS's job here is
-- exactly the same cross-ORGANIZATION isolation every other tenant-scoped
-- table in this schema already enforces, matching
-- `provisioning_requests_tenant_select`'s identical shape.
CREATE POLICY "audit_log_entries_tenant_select" ON "audit_log_entries"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));
