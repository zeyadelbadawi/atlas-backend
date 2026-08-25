-- CreateEnum
CREATE TYPE "subdomain_status" AS ENUM ('suggested', 'available', 'unavailable', 'reserved', 'assigned');

-- CreateEnum
CREATE TYPE "domain_status" AS ENUM ('not_configured', 'pending', 'verification_required', 'verifying', 'connected', 'failed', 'disconnected');

-- CreateEnum
CREATE TYPE "ssl_status" AS ENUM ('not_configured', 'pending', 'provisioning', 'active', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "cdn_status" AS ENUM ('not_configured', 'active', 'degraded', 'error');

-- CreateEnum
CREATE TYPE "infrastructure_provider_name" AS ENUM ('cloudflare');

-- CreateTable
CREATE TABLE "subdomain_allocations" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "status" "subdomain_status" NOT NULL,
    "full_host" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subdomain_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_connections" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "hostname" TEXT,
    "status" "domain_status" NOT NULL DEFAULT 'not_configured',
    "verification_records" JSONB,
    "ssl_status" "ssl_status" NOT NULL DEFAULT 'not_configured',
    "cdn_status" "cdn_status" NOT NULL DEFAULT 'not_configured',
    "cdn_provider" "infrastructure_provider_name",
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_domain_configuration" (
    "id" TEXT NOT NULL,
    "base_domain" TEXT,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_domain_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subdomain_allocations_academy_id_key" ON "subdomain_allocations"("academy_id");

-- CreateIndex
CREATE UNIQUE INDEX "subdomain_allocations_subdomain_key" ON "subdomain_allocations"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "domain_connections_academy_id_key" ON "domain_connections"("academy_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_connections_hostname_key" ON "domain_connections"("hostname");

-- AddForeignKey
ALTER TABLE "subdomain_allocations" ADD CONSTRAINT "subdomain_allocations_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_connections" ADD CONSTRAINT "domain_connections_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- P11 Row-Level Security (master plan §5.11/§7/§21 Phase P11).
--
-- `subdomain_allocations`/`domain_connections` are Academy-scoped, resolved
-- transitively (`*.academy_id → academies.organization_id`) — the exact
-- same shape and session variable (`app.current_organization_id`) every
-- prior phase's tenant tables already use. SELECT/INSERT/UPDATE only on
-- both — no DELETE policy, matching the archive-only precedent
-- (`media_assets`/`website_faq_entries`/`website_testimonial_entries`):
-- `removeCustomDomain` resets `domain_connections` fields via UPDATE,
-- never a hard delete; nothing in the real `DomainService` contract
-- deletes a `subdomain_allocations` row at all.
--
-- `platform_domain_configuration` is a Platform-owned singleton (mirrors
-- `trial_policy`, P4) — not tenant-scoped, no RLS, matching
-- `trial_policy`/`schema_meta`'s identical precedent.
-- ============================================================================

ALTER TABLE "subdomain_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subdomain_allocations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "subdomain_allocations_tenant_select" ON "subdomain_allocations"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "subdomain_allocations_insert" ON "subdomain_allocations"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "subdomain_allocations_tenant_update" ON "subdomain_allocations"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_allocations"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

ALTER TABLE "domain_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "domain_connections" FORCE ROW LEVEL SECURITY;

CREATE POLICY "domain_connections_tenant_select" ON "domain_connections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "domain_connections_insert" ON "domain_connections"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "domain_connections_tenant_update" ON "domain_connections"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "domain_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- ============================================================================
-- `resolve_public_hostname` — the ONE narrow, purpose-built `SECURITY
-- DEFINER` function the public (unauthenticated) runtime uses, mirroring
-- P7's exact justification and shape (`is_course_instructor` etc.):
-- a public visitor has no `app.current_organization_id` to set at all — an
-- ordinary RLS-governed query against `domain_connections`/
-- `subdomain_allocations`/`academies` would correctly return nothing for
-- EVERY visitor, which is fail-closed-correct for every OTHER access path
-- in this codebase but is exactly wrong for the one legitimate case where
-- an unauthenticated caller must be able to resolve ITS OWN Academy from a
-- trusted hostname it already knows, across every tenant, by construction
-- (a public visitor could be looking for any Academy's site).
--
-- This function is the sole, explicit, documented exception: it bypasses
-- RLS internally for this one read (owned by the migration role, exactly
-- like P7's functions), returns only the minimal public-safe fields
-- (`academy_id`/`organization_id`/name/slug/logo — never anything else),
-- and is called from `PublicWebsiteService`'s own restricted `atlas_app`
-- connection — never a superuser/`DATABASE_URL` connection. Once this
-- function returns an `organization_id`, every SUBSEQUENT query in the
-- same request (fetching the published `website_configurations`/
-- `website_pages` rows) runs through the normal, unmodified
-- `runInTenantContext(organizationId, ...)` path — this function is not a
-- blanket bypass, only the one narrow step ordinary RLS structurally
-- cannot perform for an anonymous caller.
--
-- Resolution order: an exact, `connected` custom-domain hostname match
-- wins over a subdomain-label match (`priority` column) — a real product
-- ambiguity (the same string coincidentally being both) is vanishingly
-- unlikely but resolved deterministically regardless, never by
-- undefined `UNION ALL` ordering.
-- ============================================================================

CREATE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
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
  ORDER BY matched.priority
  LIMIT 1;
$$;

-- ============================================================================
-- `resolve_academy_organization` — a second, equally narrow `SECURITY
-- DEFINER` function for the public runtime's remaining three endpoints
-- (`getPublishedWebsite`/`getPublishedPages`/`getPublishedPage`), which
-- the real frontend contract addresses directly by `academyId` (obtained
-- from a prior, real `resolveHostname` response — never a client
-- academyId trusted as the SOLE tenant-isolation boundary; see this
-- file's own doc comment above `resolve_public_hostname` for why reading
-- ANY academy's already-`published` website by a known/guessed id is not
-- itself a leak — publication means public by definition, and every
-- subsequent query is still gated by `status = 'published'`/
-- `visible = true`, never by this function's result alone).
--
-- Resolves only the one fact ordinary RLS cannot supply to an
-- unauthenticated caller: which organization a given academy id belongs
-- to, so `runInTenantContext` can be entered legitimately for the rest of
-- the request. Returns nothing else — no name, no email, no billing
-- state, nothing beyond the bare id a public request already supplied
-- plus the organization id needed to open a normal, unmodified RLS
-- context for every subsequent query.
-- ============================================================================

CREATE FUNCTION resolve_academy_organization(p_academy_id text)
RETURNS TABLE(organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a."organization_id"
  FROM "academies" a
  WHERE a."id" = p_academy_id;
$$;
