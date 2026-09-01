-- ============================================================================
-- Second corrective follow-up to 20260901000000_p21_academy_scoped_website_
-- domain_blog_students / 20260901000100_p21b_public_website_read_bypass.
--
-- Root cause, confirmed by direct reproduction: Postgres's handling of
-- CUSTOM (placeholder) GUCs means `current_setting('app.current_user_id',
-- true) IS NULL` is only true for a physical connection that has NEVER
-- once had `app.current_user_id` set on it. In the app's real connection
-- pool, once ANY transaction on a given physical connection calls
-- `set_config('app.current_user_id', <realUserId>, true)` — even
-- transaction-locally — Postgres permanently registers that placeholder
-- GUC on the connection; every LATER transaction on that same pooled
-- connection that does not itself set it then reads back `''` (empty
-- string), never `NULL` again, for the lifetime of that physical
-- connection. A fresh, never-reused connection (e.g. a one-off script)
-- still reads `NULL` — which is exactly what made the previous
-- migration's manual verification pass while the real, pooled, e2e-test
-- request path failed (`PublicWebsiteService.getPublishedWebsite`
-- returning nothing for a genuinely published, public config).
--
-- Fix: treat "no real user id set on THIS transaction" as `NULL` OR `''`
-- — both mean the same thing (nobody set a real, non-empty user id) —
-- instead of only `NULL`. No security change: `is_academy_member(id, '')`
-- was already false anyway, so this only widens the ANONYMOUS-and-
-- published bypass to also cover the empty-string case that a real
-- deployment's connection pool produces far more often than NULL.
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
        COALESCE(current_setting('app.current_user_id', true), '') = ''
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
        COALESCE(current_setting('app.current_user_id', true), '') = ''
        AND "website_pages"."visible" = true
      )
    )
  );
