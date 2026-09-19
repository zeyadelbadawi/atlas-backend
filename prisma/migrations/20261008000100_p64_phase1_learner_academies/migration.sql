-- ============================================================================
-- P64 Phase 1 (AD-4/AD-5) — `resolve_learner_academies(user_id)`.
--
-- The principal resolver needs, for one user, every Academy they hold a
-- student membership in together with that Academy's public host facts, so
-- a learner refused on the management surface can be sent to the right
-- academy website. `subdomain_allocations`/`domain_connections` are tenant
-- scoped by RLS and a learner holds no tenant context, hence a SECURITY
-- DEFINER read that exposes only the public-host facts the public website
-- resolver already serves anonymously (`resolve_public_hostname`).
-- ============================================================================

CREATE OR REPLACE FUNCTION resolve_learner_academies(p_user_id text)
RETURNS TABLE (
  academy_id text,
  academy_name text,
  academy_slug text,
  academy_status text,
  membership_status text,
  blocked_at timestamp(3),
  joined_at timestamp(3),
  custom_hostname text,
  custom_domain_live boolean,
  subdomain text,
  subdomain_full_host text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a."id",
    a."name",
    a."slug",
    a."status"::text,
    s."status"::text,
    s."blocked_at",
    s."joined_at",
    dc."hostname",
    (dc."hostname" IS NOT NULL AND dc."status"::text = 'connected'),
    sa."subdomain",
    sa."full_host"
  FROM "academy_students" s
  JOIN "academies" a ON a."id" = s."academy_id"
  LEFT JOIN "domain_connections" dc ON dc."academy_id" = a."id"
  LEFT JOIN "subdomain_allocations" sa ON sa."academy_id" = a."id" AND sa."status"::text = 'assigned'
  WHERE s."user_id" = p_user_id
    AND a."archived_at" IS NULL
  ORDER BY s."joined_at" ASC;
$$;
