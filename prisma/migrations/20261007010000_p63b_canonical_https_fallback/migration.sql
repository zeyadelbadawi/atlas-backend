-- ============================================================================
-- P63b — canonical host falls back to the Atlas subdomain when the
-- connected custom domain is KNOWN to be unreachable over HTTPS.
--
-- `resolve_public_hostname` (P63) reports the Academy's connected custom
-- hostname so the public runtime can name one canonical host. A domain
-- can be `connected` at the provider yet not answer over HTTPS (DNS the
-- customer changed after verification, an expired edge certificate,
-- …). Atlas's own probe records that as `https_reachable = false`. Sending
-- every visitor from the working Atlas subdomain to such a host would
-- turn the safety net into a dead end, so the canonical choice ignores a
-- custom hostname whose last probe failed. Matching a visitor who arrives
-- ON the custom hostname is unchanged (priority 1, `connected`).
-- Same signature and OUT list as P63, so CREATE OR REPLACE suffices.
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
RETURNS TABLE(
  academy_id text,
  organization_id text,
  academy_name text,
  academy_slug text,
  academy_logo_url text,
  custom_hostname text,
  subdomain text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a."id",
    a."organization_id",
    a."name",
    a."slug",
    a."logo_url",
    (SELECT dc2."hostname" FROM "domain_connections" dc2
       WHERE dc2."academy_id" = a."id"
         AND dc2."status" = 'connected'
         AND dc2."https_reachable" IS DISTINCT FROM false) AS custom_hostname,
    (SELECT sa2."subdomain" FROM "subdomain_allocations" sa2
       WHERE sa2."academy_id" = a."id" AND sa2."status" = 'assigned') AS subdomain
  FROM (
    SELECT dc."academy_id" AS academy_id, 1 AS priority
    FROM "domain_connections" dc
    WHERE dc."hostname" = p_hostname AND dc."status" = 'connected'
    UNION ALL
    SELECT sa."academy_id" AS academy_id, 2 AS priority
    FROM "subdomain_allocations" sa
    WHERE p_subdomain_label IS NOT NULL
      AND sa."subdomain" = p_subdomain_label
      AND sa."status" = 'assigned'
  ) matched
  JOIN "academies" a ON a."id" = matched.academy_id
  WHERE a."status" NOT IN ('archived', 'suspended')
  ORDER BY matched.priority
  LIMIT 1;
$$;
