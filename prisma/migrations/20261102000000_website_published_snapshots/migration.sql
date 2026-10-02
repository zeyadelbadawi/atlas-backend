-- Real draft/publish for Academy websites (2 Oct 2026).
--
-- Until now the public site read the LIVE working copy: a saved edit went
-- public within the 5-minute cache TTL with no publish, and a publish only
-- appeared to be needed because it was the one thing that changed the cache
-- key. From here the public runtime reads a published copy, written only by
-- a publish (whole site or one page).
--
-- Additive: new nullable columns, a backfill, and the anonymous branch of one
-- SELECT policy. No row is deleted or rewritten except to fill the new columns.

ALTER TABLE "website_pages"
  ADD COLUMN "published_title" TEXT,
  ADD COLUMN "published_slug" TEXT,
  ADD COLUMN "published_visible" BOOLEAN,
  ADD COLUMN "published_seo" JSONB,
  ADD COLUMN "published_sections" JSONB,
  ADD COLUMN "published_version" INTEGER,
  ADD COLUMN "published_at" TIMESTAMP(3);

ALTER TABLE "website_configurations"
  ADD COLUMN "published_snapshot" JSONB;

-- Every website that is published right now keeps serving exactly what it
-- serves today: its current working copy becomes its published copy.
UPDATE "website_pages" p
SET "published_title" = p."title",
    "published_slug" = p."slug",
    "published_visible" = p."visible",
    "published_seo" = p."seo",
    "published_sections" = p."sections",
    "published_version" = p."version",
    "published_at" = CURRENT_TIMESTAMP
FROM "website_configurations" c
WHERE c."academy_id" = p."academy_id"
  AND c."status" = 'published';

UPDATE "website_configurations"
SET "published_snapshot" = jsonb_build_object(
      'themeKey', "theme_key",
      'themeVersion', "theme_version",
      'brand', "brand",
      'seo', "seo",
      'navigation', "navigation",
      'header', "header",
      'footer', "footer"
    )
WHERE "status" = 'published';

-- Anonymous (public-runtime) page reads follow the PUBLISHED visibility, not
-- the working copy's: hiding a page in the editor must not take it off the
-- live site before the owner publishes. Members' reads are unchanged.
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
        AND "website_pages"."published_visible" = true
      )
    )
  );

-- The hostname presentation (theme key + colours, 20261030000000) follows the
-- published copy once a website is published, so a draft brand or theme
-- change cannot reach the live site through it either. An unpublished
-- website keeps wearing its working copy on Coming Soon, as before.
CREATE OR REPLACE FUNCTION resolve_public_presentation(p_academy_id text)
RETURNS TABLE(theme_key text, brand jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(src.snapshot ->> 'themeKey', wc."theme_key"),
    jsonb_strip_nulls(jsonb_build_object(
      'primaryColor', src.brand -> 'primaryColor',
      'secondaryColor', src.brand -> 'secondaryColor',
      'accentColor', src.brand -> 'accentColor',
      'palette', src.brand -> 'palette'
    ))
  FROM "website_configurations" wc
  JOIN "academies" a ON a."id" = wc."academy_id"
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN wc."status" = 'published' THEN wc."published_snapshot" END AS snapshot,
      CASE
        WHEN wc."status" = 'published' AND wc."published_snapshot" IS NOT NULL
          THEN wc."published_snapshot" -> 'brand'
        ELSE wc."brand"
      END AS brand
  ) src
  WHERE wc."academy_id" = p_academy_id
    AND a."status" NOT IN ('archived', 'suspended');
$$;

REVOKE ALL ON FUNCTION resolve_public_presentation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_public_presentation(text) TO "atlas_app";
