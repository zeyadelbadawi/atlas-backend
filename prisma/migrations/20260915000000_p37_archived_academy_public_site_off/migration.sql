-- Phase 10.5 — a deleted Academy must stop serving its public website.
--
-- THE DEFECT. `resolve_public_hostname` joined `academies` with no status
-- filter at all, so an Academy that had been archived (Atlas's delete —
-- there is deliberately no DELETE RLS policy on `academies`) continued to
-- resolve and serve its public site exactly as before. Verified directly
-- against the function before writing this: archiving an Academy and then
-- calling the resolver still returned it.
--
-- That is a real problem beyond tidiness: a customer who deletes an
-- Academy reasonably expects its public presence to go away, and until
-- now the site stayed online indefinitely.
--
-- THE FIX. Refuse Academies that have been taken down — and ONLY those.
--
-- A first draft of this filtered on `status = 'active'`, which would have
-- been a serious mistake: `AcademyStatus` DEFAULTS to `draft`, and
-- production is 5 draft to 1 active. Requiring `active` would have taken
-- five of six live customer websites offline. Caught by running the test
-- suite before deploying, not by reading the migration.
--
-- `draft` is therefore explicitly ALLOWED: it is the ordinary state of a
-- working Academy in this schema, not an unpublished one. Publication is
-- controlled separately, per page and per website configuration, by the
-- `status = 'published'` checks the public runtime already applies to
-- every subsequent query.
--
-- `suspended` is excluded alongside `archived`: both mean the Academy has
-- been deliberately stopped.

CREATE OR REPLACE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
RETURNS TABLE(
  academy_id text,
  organization_id text,
  academy_name text,
  academy_slug text,
  academy_logo_url text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a."id", a."organization_id", a."name", a."slug", a."logo_url"
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
  -- The only change from the P11 definition: an Academy that has been
  -- taken down is not reachable. Note this is an EXCLUSION, not an
  -- allow-list — see the header for why requiring 'active' was wrong.
  WHERE a."status" NOT IN ('archived', 'suspended')
  ORDER BY matched.priority
  LIMIT 1;
$$;

-- NOTE ON THE SUBDOMAIN ALLOCATION. Archiving deliberately does NOT
-- release the `subdomain_allocations` row. The slug stays claimed, so a
-- different customer cannot take over the hostname of an Academy that
-- previously existed there and inherit whatever links, references or
-- trust that hostname carried. The Academy allowance on the plan is
-- released independently, through the usage recompute that archiving
-- already triggers, so keeping the hostname reserved does not prevent the
-- owner creating a replacement Academy.
