-- CreateEnum
CREATE TYPE "organization_status" AS ENUM ('active', 'suspended', 'archived');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "organization_status" NOT NULL DEFAULT 'active',
    "owner_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_idx" ON "organization_memberships"("user_id");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_idx" ON "organization_memberships"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- Session variable: `app.current_organization_id`, set once per request via
-- `SET LOCAL` inside the same Postgres transaction as the query it protects
-- (see `TenancyContextService.runInTenantContext` in the application code).
-- `SET LOCAL` is transaction-scoped by Postgres's own semantics — it cannot
-- leak into a different transaction/connection, which is what makes this
-- safe under concurrent requests without any application-level locking.
--
-- `FORCE ROW LEVEL SECURITY` matters here specifically because this
-- database's own connection role (`atlas`, from docker-compose/.env) is the
-- OWNER of every table it creates via migrations. Postgres exempts table
-- owners from RLS by default — without `FORCE`, every policy below would be
-- silently bypassed for the exact role the application connects as, making
-- the isolation guarantee theater rather than real defense-in-depth
-- alongside the application-layer membership checks.
--
-- Command coverage is deliberate, not an oversight:
--   SELECT — strictly scoped to the current tenant context. This is the
--     guarantee the tenant-isolation test suite (§18) exists to prove.
--   INSERT — intentionally permissive (`WITH CHECK (true)`). Neither table
--     has a P2 API endpoint that creates rows (no organization-creation or
--     membership-creation endpoint exists in this phase — see the P2 final
--     report's "SPECIFICATION-UNDEFINED" section); row creation today only
--     happens via trusted internal paths (test fixtures now, a future
--     Provisioning/onboarding worker in Phase P14). Scoping INSERT to an
--     as-yet-nonexistent tenant context is a contradiction in terms for
--     `organizations` (the row being created *is* the new tenant) and would
--     just move the trust boundary, not add one, for `organization_memberships`
--     until a real invitation/onboarding authorization model is specified.
--   UPDATE / DELETE — no policy defined for either command on either table,
--     which under Postgres RLS means those commands are denied entirely
--     regardless of context. This matches the explicit P2 requirement of no
--     organization update/delete capability and no membership-management
--     capability beyond what's specified — enforced at the database level,
--     not merely by omitting a controller route.
-- ============================================================================

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organizations_tenant_select" ON "organizations"
  FOR SELECT
  USING ("id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organizations_insert" ON "organizations"
  FOR INSERT
  WITH CHECK (true);

ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_memberships_tenant_select" ON "organization_memberships"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_memberships_insert" ON "organization_memberships"
  FOR INSERT
  WITH CHECK (true);
