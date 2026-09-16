-- ============================================================================
-- P63 — Domain, subdomain & website access: operational truth.
--
-- Additive and reversible. Nothing here rewrites an existing row.
--
-- 1. `domain_connections` gains the columns the customer and the Platform
--    Owner need to answer "has Atlas checked my domain, when, what went
--    wrong, and is HTTPS actually working":
--      provider_hostname_id — the provider's own id for the custom hostname
--      last_checked_at      — when Atlas last asked the provider
--      last_check_error     — a stable, non-sensitive error code (never a
--                             raw provider message, never a credential)
--      https_reachable / https_checked_at — Atlas's own outbound HTTPS
--                             probe of the hostname; real telemetry
--    All nullable; NULL means "never checked", which is byte-for-byte how
--    every existing row already behaves.
--
-- 2. `domain_connections_platform_update` — the verification sweep and the
--    Platform Owner "check now" action run cross-tenant under
--    `runInUserContext(<platform owner id>)`, exactly like the trial-expiry
--    sweep on `tenant_subscriptions` (P22). The only pre-existing write
--    policy, `domain_connections_tenant_update`, is scoped to the row's own
--    organization AND academy membership, which a platform job never has.
--    Same `_platform_select`/`_platform_update` pair shape as its siblings.
--    Deliberately no platform INSERT/DELETE: the platform never creates a
--    customer's domain and nothing deletes one (see P11's "reset, never a
--    hard delete").
--
-- 3. `resolve_public_hostname` now also returns the Academy's connected
--    custom hostname and its assigned subdomain label, so the public
--    runtime can compute ONE canonical host per Academy (custom domain when
--    connected, otherwise the Atlas subdomain) without any second
--    definer function or any RLS exception. The matching rules, the
--    archived/suspended exclusion (P37) and the priority order are
--    unchanged. A return-type change requires DROP + CREATE (Postgres
--    refuses CREATE OR REPLACE across a different OUT list).
-- ============================================================================

ALTER TABLE "domain_connections"
  ADD COLUMN IF NOT EXISTS "provider_hostname_id" TEXT,
  ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_check_error" TEXT,
  ADD COLUMN IF NOT EXISTS "https_reachable" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "https_checked_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "domain_connections_status_idx"
  ON "domain_connections" ("status");
CREATE INDEX IF NOT EXISTS "domain_connections_last_checked_at_idx"
  ON "domain_connections" ("last_checked_at");

DROP POLICY IF EXISTS "domain_connections_platform_update" ON "domain_connections";
CREATE POLICY "domain_connections_platform_update" ON "domain_connections"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

DROP FUNCTION IF EXISTS resolve_public_hostname(text, text);

CREATE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
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
       WHERE dc2."academy_id" = a."id" AND dc2."status" = 'connected') AS custom_hostname,
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
