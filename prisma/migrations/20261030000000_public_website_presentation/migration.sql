-- ============================================================================
-- Theme 1 plan, Phase 6 — the hostname lookup's `presentation`.
--
-- Before a website is published the public runtime shows Coming Soon. The
-- Owner chose (Phase 6) to render it in the Academy's theme and public
-- brand colours, so the hostname lookup returns the theme key and colours
-- whatever the publication state.
--
-- `website_configurations_tenant_select` only lets an anonymous request
-- read a PUBLISHED configuration, which is right for everything else a
-- visitor reads. This function is the narrow exception, in the same shape
-- as `resolve_public_hostname` / `resolve_academy_organization`: a
-- `SECURITY DEFINER` read that returns exactly the theme key and the four
-- colour fields of `brand` — never the draft content, navigation, pages,
-- logo, contact details or any other configuration column. Palette
-- provenance inside `brand.palette` is stripped by the caller
-- (`toPublicBrand`), as for a published site. Archived and suspended
-- Academies return nothing, matching `resolve_academy_organization`.
--
-- Additive: one function, no table, column or policy change. Rollback:
-- DROP FUNCTION resolve_public_presentation(text);
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_public_presentation(p_academy_id text)
RETURNS TABLE(theme_key text, brand jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    wc."theme_key",
    jsonb_strip_nulls(jsonb_build_object(
      'primaryColor', wc."brand" -> 'primaryColor',
      'secondaryColor', wc."brand" -> 'secondaryColor',
      'accentColor', wc."brand" -> 'accentColor',
      'palette', wc."brand" -> 'palette'
    ))
  FROM "website_configurations" wc
  JOIN "academies" a ON a."id" = wc."academy_id"
  WHERE wc."academy_id" = p_academy_id
    AND a."status" NOT IN ('archived', 'suspended');
$$;

REVOKE ALL ON FUNCTION resolve_public_presentation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_public_presentation(text) TO "atlas_app";
