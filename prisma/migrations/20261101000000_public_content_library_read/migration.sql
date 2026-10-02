-- ============================================================================
-- Public read of the FAQ & testimonial content library (P3).
--
-- The public pages payload now expands a section's `libraryEntryIds` into
-- the entries themselves (`PublicWebsiteService.getPublishedPages`), read
-- in the ANONYMOUS tenant context (organization set, no user) — the same
-- context the public runtime already reads `website_configurations` and
-- `website_pages` in. Until now the library's SELECT policy admitted
-- Academy members only (P10), so that read returned nothing.
--
-- Same shape as `website_pages_tenant_select` (20260901000200): the
-- organization must match, and then either the caller is a member (the
-- dashboard, unchanged) or there is no user on this transaction ('' or
-- NULL — see that migration for why both) AND the entry is published AND
-- visible. Drafts, hidden and archived entries stay member-only. INSERT,
-- UPDATE and DELETE policies are not touched.
-- ============================================================================

DROP POLICY "website_faq_entries_tenant_select" ON "website_faq_entries";

CREATE POLICY "website_faq_entries_tenant_select" ON "website_faq_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_faq_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
    AND (
      is_academy_member("website_faq_entries"."academy_id", current_setting('app.current_user_id', true))
      OR (
        COALESCE(current_setting('app.current_user_id', true), '') = ''
        AND "website_faq_entries"."status" = 'published'
        AND "website_faq_entries"."visible" = true
      )
    )
  );

DROP POLICY "website_testimonial_entries_tenant_select" ON "website_testimonial_entries";

CREATE POLICY "website_testimonial_entries_tenant_select" ON "website_testimonial_entries"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "website_testimonial_entries"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
    AND (
      is_academy_member("website_testimonial_entries"."academy_id", current_setting('app.current_user_id', true))
      OR (
        COALESCE(current_setting('app.current_user_id', true), '') = ''
        AND "website_testimonial_entries"."status" = 'published'
        AND "website_testimonial_entries"."visible" = true
      )
    )
  );
