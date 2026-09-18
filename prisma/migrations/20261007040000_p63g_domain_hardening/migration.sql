-- ============================================================================
-- P63g — Custom Domains hardening (production audit of 18 Sep 2026).
--
-- 1. `domain_provider_releases`: a provider resource Atlas gave up (replace,
--    remove, archive, operator release) is recorded IN THE SAME TRANSACTION
--    as the change that gave it up, deleted at the provider only after
--    commit, and retried by the sweep until the provider confirms. Before
--    this, the provider delete ran inside the transaction BEFORE the write
--    that could still fail: a customer replacing a live domain with one
--    another tenant held got a 409 — and their working hostname had already
--    been deleted at the edge (reproduced against the real database).
--    RLS: FORCE; tenant INSERT/SELECT scoped like `domain_connections`;
--    platform SELECT/INSERT/UPDATE/DELETE (the sweep and the operator
--    release run as a platform owner). Never readable across tenants.
--
-- 2. `domain_connections.consecutive_failures`: exponential backoff for the
--    sweep, so a permanently refused or abandoned hostname is not re-asked
--    (and re-registered) every five minutes forever.
--
-- 3. Lowercase invariants: `hostname` and `subdomain` uniqueness was
--    case-sensitive and held only by application convention; the resolver
--    always compares a lowercased input. A CHECK makes the convention a
--    database guarantee (existing rows are verified below before the
--    constraint is added — a mixed-case row would fail this migration
--    loudly rather than be silently unreachable).
--
-- 4. `platform_domain_configuration.last_sweep_*`: sweep observability.
--
-- 5. `resolve_academy_organization` now refuses archived/suspended
--    Academies, closing the by-`academyId` public reads (and the contact
--    form) that kept serving an archived Academy after its hostnames went
--    dark (P37 promised the site goes offline; only the hostname path did).
--
-- Additive except the CHECK constraints and the function body. Rollback:
-- drop the table, the two columns, the two CHECKs, and restore the
-- function body from `20260825131712_p11_public_website_runtime_domains_edge`.
-- ============================================================================

ALTER TABLE "domain_connections"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "platform_domain_configuration"
  ADD COLUMN IF NOT EXISTS "last_sweep_completed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_sweep_result" JSONB;

-- 3. Lowercase invariants (verify first, then constrain).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "domain_connections" WHERE "hostname" IS NOT NULL AND "hostname" <> lower("hostname")) THEN
    RAISE EXCEPTION 'P63g: domain_connections has a mixed-case hostname; normalise it before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM "subdomain_allocations" WHERE "subdomain" <> lower("subdomain")) THEN
    RAISE EXCEPTION 'P63g: subdomain_allocations has a mixed-case subdomain; normalise it before migrating';
  END IF;
END $$;

ALTER TABLE "domain_connections"
  DROP CONSTRAINT IF EXISTS "domain_connections_hostname_lowercase",
  ADD CONSTRAINT "domain_connections_hostname_lowercase"
    CHECK ("hostname" IS NULL OR "hostname" = lower("hostname"));

ALTER TABLE "subdomain_allocations"
  DROP CONSTRAINT IF EXISTS "subdomain_allocations_subdomain_lowercase",
  ADD CONSTRAINT "subdomain_allocations_subdomain_lowercase"
    CHECK ("subdomain" = lower("subdomain"));

-- 1. Provider release ledger.
CREATE TABLE IF NOT EXISTS "domain_provider_releases" (
  "id" TEXT NOT NULL,
  "academy_id" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "provider_hostname_id" TEXT,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_attempted_at" TIMESTAMP(3),
  "last_error" TEXT,
  "released_at" TIMESTAMP(3),
  "outcome" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_provider_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "domain_provider_releases_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "domain_provider_releases_released_at_idx"
  ON "domain_provider_releases" ("released_at");
CREATE INDEX IF NOT EXISTS "domain_provider_releases_academy_id_idx"
  ON "domain_provider_releases" ("academy_id");

ALTER TABLE "domain_provider_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_provider_releases" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "domain_provider_releases_tenant_select" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_tenant_select" ON "domain_provider_releases"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_provider_releases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "domain_provider_releases_tenant_insert" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_tenant_insert" ON "domain_provider_releases"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_provider_releases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "domain_provider_releases_platform_select" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_platform_select" ON "domain_provider_releases"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "domain_provider_releases_platform_insert" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_platform_insert" ON "domain_provider_releases"
  FOR INSERT WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "domain_provider_releases_platform_update" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_platform_update" ON "domain_provider_releases"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "domain_provider_releases_platform_delete" ON "domain_provider_releases";
CREATE POLICY "domain_provider_releases_platform_delete" ON "domain_provider_releases"
  FOR DELETE USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- 5. Archived/suspended Academies stop serving every public read.
CREATE OR REPLACE FUNCTION resolve_academy_organization(p_academy_id text)
RETURNS TABLE(organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a."organization_id"
  FROM "academies" a
  WHERE a."id" = p_academy_id
    AND a."status" NOT IN ('archived', 'suspended');
$$;

-- Observability: how many provider releases are still pending, readable
-- by the Platform Owner readiness view without any tenant context. A
-- number only — no hostname, no tenant identifier crosses this boundary.
CREATE OR REPLACE FUNCTION count_pending_domain_releases()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM "domain_provider_releases" WHERE "released_at" IS NULL;
$$;

-- Base-domain change: rewrite every allocation's advertised full host in
-- one place (previously nothing did, so existing Academies advertised the
-- old domain forever). Returns the labels touched and the host each one
-- advertised before, so the caller can drop stale cache entries.
CREATE OR REPLACE FUNCTION rewrite_subdomain_full_hosts(p_base_domain text)
RETURNS TABLE(subdomain text, previous_full_host text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE "subdomain_allocations" sa
    SET "full_host" = sa."subdomain" || '.' || lower(p_base_domain),
        "updated_at" = CURRENT_TIMESTAMP
    FROM (SELECT "id", "full_host" AS previous_full_host FROM "subdomain_allocations") prev
    WHERE prev."id" = sa."id"
      AND (sa."full_host" IS DISTINCT FROM (sa."subdomain" || '.' || lower(p_base_domain)))
    RETURNING sa."subdomain", prev.previous_full_host
  )
  SELECT "subdomain", previous_full_host FROM updated;
$$;

-- The public runtime computed the canonical host from label + env base
-- domain while the dashboard used the allocation's stored full host: two
-- rules, two answers. The resolver now returns the stored full host too,
-- so both sides feed the same inputs to `resolveCanonicalHost`. A return-
-- type change requires DROP + CREATE. Matching rules, archived/suspended
-- exclusion and priority order are unchanged.
DROP FUNCTION IF EXISTS resolve_public_hostname(text, text);
CREATE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
RETURNS TABLE(
  academy_id text,
  organization_id text,
  academy_name text,
  academy_slug text,
  academy_logo_url text,
  custom_hostname text,
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
    a."organization_id",
    a."name",
    a."slug",
    a."logo_url",
    (SELECT dc2."hostname" FROM "domain_connections" dc2
       WHERE dc2."academy_id" = a."id"
         AND dc2."status" = 'connected'
         AND dc2."https_reachable" IS DISTINCT FROM false) AS custom_hostname,
    (SELECT sa2."subdomain" FROM "subdomain_allocations" sa2
       WHERE sa2."academy_id" = a."id" AND sa2."status" = 'assigned') AS subdomain,
    (SELECT sa3."full_host" FROM "subdomain_allocations" sa3
       WHERE sa3."academy_id" = a."id" AND sa3."status" = 'assigned') AS subdomain_full_host
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
