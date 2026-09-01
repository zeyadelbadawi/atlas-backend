-- ============================================================================
-- Corrective follow-up to 20260901000000_p21_academy_scoped_website_domain_
-- blog_students. That migration's `website_configurations_tenant_select`/
-- `website_pages_tenant_select` rewrite unintentionally broke the public
-- (unauthenticated) website runtime: `PublicWebsiteService` opens a
-- legitimate `runInTenantContext(organizationId, ...)` for an anonymous
-- visitor (via `resolve_academy_organization`), but never sets
-- `app.current_user_id` at all (there is no user) — so
-- `is_academy_member(academy_id, current_user_id)` always evaluated false
-- for that caller, hiding even already-`published`/`visible` content from
-- the public it is published for. Caught by the pre-existing "Public
-- Website Runtime (e2e)" suite.
--
-- Fix: SELECT is granted either to a real academy member (dashboard/
-- staff use — unchanged from the previous migration) OR to a genuinely
-- anonymous caller (`app.current_user_id` not set at all) reading content
-- that is ALREADY publicly published (`website_configurations.status =
-- 'published'`, `website_pages.visible = true`) — mirroring exactly what
-- `WebsiteConfigurationRepository.findPublishedByAcademyId`/
-- `WebsitePagesRepository.findAllPublished` already filter for at the
-- application layer; this is not a new exposure, only the RLS layer
-- catching up to a query condition that already existed. An
-- AUTHENTICATED caller who is not an academy member (the Gap A scenario)
-- still gets nothing — `current_user_id` is set for them, so the
-- anonymous branch does not apply. Organization-level tenant isolation
-- (the `a.organization_id = app.current_organization_id` clause) is
-- unchanged.
-- ============================================================================

DROP POLICY "website_configurations_tenant_select" ON "website_configurations";

CREATE POLICY "website_configurations_tenant_select" ON "website_configurations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_configurations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
    AND (
      is_academy_member("website_configurations"."academy_id", current_setting('app.current_user_id', true))
      OR (
        current_setting('app.current_user_id', true) IS NULL
        AND "website_configurations"."status" = 'published'
      )
    )
  );

DROP POLICY "website_pages_tenant_select" ON "website_pages";

CREATE POLICY "website_pages_tenant_select" ON "website_pages"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_pages"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
    AND (
      is_academy_member("website_pages"."academy_id", current_setting('app.current_user_id', true))
      OR (
        current_setting('app.current_user_id', true) IS NULL
        AND "website_pages"."visible" = true
      )
    )
  );
