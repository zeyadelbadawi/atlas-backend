-- ============================================================================
-- Third corrective follow-up to 20260901000000_p21_academy_scoped_website_
-- domain_blog_students. `subdomain_allocations` was the one table of the
-- six touched by that migration's Part 3 that never had a genuine
-- `_platform_select` policy (`website_configurations`/`domain_connections`
-- already do, since P15). Before this phase, that gap was invisible: the
-- Platform Owner's own read path (`PlatformProvisioningService.toResponse`,
-- P14) opens `runInTenantAndUserContext(request.organizationId,
-- reviewerId, ...)` — setting `app.current_organization_id` to the TARGET
-- organization — which trivially satisfied the OLD org-scoped-only
-- `subdomain_allocations_tenant_select` policy regardless of who the
-- caller actually was. Adding `is_academy_member` to that policy (this
-- phase's own Gap A fix) correctly closed that loophole for ordinary
-- callers, but also correctly exposed that the Platform Owner never had a
-- REAL bypass here, unlike the other two tables — caught by the
-- pre-existing "a Platform Owner can get any organization's provisioning
-- request by id" e2e test. Fix: add the identical `_platform_select`
-- policy this table always should have had, matching its two siblings.
-- ============================================================================

CREATE POLICY "subdomain_allocations_platform_select" ON "subdomain_allocations"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));
