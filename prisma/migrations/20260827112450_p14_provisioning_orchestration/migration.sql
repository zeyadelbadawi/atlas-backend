-- CreateEnum
CREATE TYPE "provisioning_step_key" AS ENUM ('tenant', 'academy', 'theme', 'branding', 'subdomain', 'domain', 'finalization');

-- CreateEnum
CREATE TYPE "provisioning_step_status" AS ENUM ('pending', 'running', 'completed', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "provisioning_status" AS ENUM ('payment_success', 'tenant_created', 'academy_created', 'theme_applied', 'branding_applied', 'subdomain_assigned', 'custom_domain_pending', 'custom_domain_connected', 'provisioning', 'ready', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "provisioning_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "academy_id" TEXT,
    "requested_by_user_id" TEXT NOT NULL,
    "status" "provisioning_status" NOT NULL DEFAULT 'payment_success',
    "current_step_key" "provisioning_step_key" NOT NULL DEFAULT 'tenant',
    "requested_academy_name" TEXT NOT NULL,
    "requested_subdomain" TEXT NOT NULL,
    "triggering_payment_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provisioning_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_steps" (
    "id" TEXT NOT NULL,
    "provisioning_request_id" TEXT NOT NULL,
    "key" "provisioning_step_key" NOT NULL,
    "status" "provisioning_step_status" NOT NULL DEFAULT 'pending',
    "attempt_number" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error" JSONB,

    CONSTRAINT "provisioning_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_requests_academy_id_key" ON "provisioning_requests"("academy_id");

-- CreateIndex
CREATE INDEX "provisioning_requests_organization_id_status_idx" ON "provisioning_requests"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_requests_organization_id_idempotency_key_key" ON "provisioning_requests"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "provisioning_steps_provisioning_request_id_idx" ON "provisioning_steps"("provisioning_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_steps_provisioning_request_id_key_key" ON "provisioning_steps"("provisioning_request_id", "key");

-- AddForeignKey
ALTER TABLE "provisioning_requests" ADD CONSTRAINT "provisioning_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_requests" ADD CONSTRAINT "provisioning_requests_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_requests" ADD CONSTRAINT "provisioning_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_requests" ADD CONSTRAINT "provisioning_requests_triggering_payment_id_fkey" FOREIGN KEY ("triggering_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_steps" ADD CONSTRAINT "provisioning_steps_provisioning_request_id_fkey" FOREIGN KEY ("provisioning_request_id") REFERENCES "provisioning_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- `provisioning_requests` reuses the exact `checkouts`/`course_orders`
-- (P12/P13) organization-tenant-scoped shape — `app.current_organization_id`,
-- no new session variable, no new tenancy mechanism. Every write (create,
-- and every step-execution write the provisioning worker performs) runs
-- under `TenancyContextService.runInTenantContext(organizationId)`; a
-- Platform Owner action (retry/cancel on a Tenant's behalf) resolves the
-- target `organizationId` first (under `is_platform_owner()`-gated
-- read-only access, see `provisioning_requests_platform_select` below) and
-- then re-enters an ordinary tenant context to actually act — the exact
-- `PlatformCourseOrderPaymentsService` (P13) precedent, never a
-- Platform-Owner-scoped write policy on this table.
--
-- `provisioning_steps` is transitively scoped through
-- `provisioning_requests.organization_id`, the same child-table shape
-- `payment_attempts`/`payment_proofs` (P12) and `revenue_ledger_entries`
-- (P13, read side) already established.
--
-- One new `SECURITY DEFINER` function, `subdomain_is_taken(text)` — the
-- same documented category as `resolve_academy_organization`/
-- `resolve_payment_organization`/`resolve_public_hostname` (P11/P12/P13):
-- a narrow, purpose-built, no-tenant-context id/fact lookup for the one
-- genuinely cross-tenant question this phase needs answered (subdomain
-- uniqueness is a GLOBAL fact, matching `subdomain_allocations.subdomain`'s
-- own `@unique` constraint — no single tenant's own RLS context can answer
-- "is this string taken by ANY organization"). Answers only a boolean,
-- never which Organization/Academy holds a given subdomain.
--
-- `subdomain_allocations`/`domain_connections` themselves need NO new RLS
-- here — the P11 migration already shipped real, unused-until-now
-- `_insert`/`_tenant_update` policies on both tables (its own doc comment:
-- "allocating a subdomain is P14's job... P11 only reads whatever a future
-- P14 populates here"), confirmed by direct inspection before writing this
-- migration. This phase is simply the first real caller of those existing
-- policies, not a reason to add new ones.
--
-- Command coverage, table-by-table:
--   SELECT — tenant-scoped (`app.current_organization_id`) on both tables;
--     `is_platform_owner()`-scoped additionally, matching the flat
--     `/provisioning-requests` Platform console surface (master plan §10).
--   INSERT — tenant-scoped only, on both tables (the worker always runs
--     under a resolved tenant context; no platform-owner INSERT path
--     exists because nothing in this phase writes a provisioning row
--     outside that context).
--   UPDATE — tenant-scoped only, on both tables (step-status transitions,
--     `current_step_key`/`attempt_count`/`last_error`/timestamps — the
--     worker's own writes, always under a resolved tenant context).
--   DELETE — none on either table, none planned (matches every prior
--     phase's identical convention for its own request/audit-shaped
--     tables).
-- ============================================================================

CREATE FUNCTION subdomain_is_taken(p_subdomain text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM "subdomain_allocations" WHERE "subdomain" = p_subdomain);
$$;

-- ---------------------------------------------------------------------------
-- provisioning_requests
-- ---------------------------------------------------------------------------

ALTER TABLE "provisioning_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "provisioning_requests_tenant_select" ON "provisioning_requests"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "provisioning_requests_platform_select" ON "provisioning_requests"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "provisioning_requests_tenant_insert" ON "provisioning_requests"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "provisioning_requests_tenant_update" ON "provisioning_requests"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- provisioning_steps (transitive via provisioning_requests.organization_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "provisioning_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_steps" FORCE ROW LEVEL SECURITY;

CREATE POLICY "provisioning_steps_tenant_select" ON "provisioning_steps"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "provisioning_requests" r
      WHERE r."id" = "provisioning_steps"."provisioning_request_id"
        AND r."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "provisioning_steps_platform_select" ON "provisioning_steps"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "provisioning_steps_tenant_insert" ON "provisioning_steps"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "provisioning_requests" r
      WHERE r."id" = "provisioning_steps"."provisioning_request_id"
        AND r."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "provisioning_steps_tenant_update" ON "provisioning_steps"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "provisioning_requests" r
      WHERE r."id" = "provisioning_steps"."provisioning_request_id"
        AND r."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "provisioning_requests" r
      WHERE r."id" = "provisioning_steps"."provisioning_request_id"
        AND r."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
