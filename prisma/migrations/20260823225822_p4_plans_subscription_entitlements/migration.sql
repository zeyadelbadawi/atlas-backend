-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "tenant_subscription_status" AS ENUM ('trialing', 'active', 'past_due', 'paused', 'grace_period', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "subscription_billing_cycle" AS ENUM ('monthly', 'yearly');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "plan_status" NOT NULL DEFAULT 'active',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "limits" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "pricing" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "add_ons" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" JSONB NOT NULL,
    "compatible_plan_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricing" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_subscriptions" (
    "organization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "tenant_subscription_status" NOT NULL DEFAULT 'trialing',
    "trial_ends_at" TIMESTAMP(3),
    "grace_ends_at" TIMESTAMP(3),
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "billing_cycle" "subscription_billing_cycle",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "tenant_add_ons" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "add_on_id" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_usage" (
    "organization_id" TEXT NOT NULL,
    "academies" INTEGER NOT NULL DEFAULT 0,
    "students" INTEGER NOT NULL DEFAULT 0,
    "instructors" INTEGER NOT NULL DEFAULT 0,
    "staff" INTEGER NOT NULL DEFAULT 0,
    "courses" INTEGER NOT NULL DEFAULT 0,
    "general_storage_gb" INTEGER NOT NULL DEFAULT 0,
    "video_storage_gb" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_usage_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "trial_policy" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "duration_days" INTEGER NOT NULL DEFAULT 7,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plans_status_display_order_idx" ON "plans"("status", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "add_ons_key_key" ON "add_ons"("key");

-- CreateIndex
CREATE INDEX "tenant_subscriptions_plan_id_idx" ON "tenant_subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "tenant_add_ons_organization_id_idx" ON "tenant_add_ons"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_add_ons_organization_id_add_on_id_key" ON "tenant_add_ons"("organization_id", "add_on_id");

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_add_ons" ADD CONSTRAINT "tenant_add_ons_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_add_ons" ADD CONSTRAINT "tenant_add_ons_add_on_id_fkey" FOREIGN KEY ("add_on_id") REFERENCES "add_ons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_usage" ADD CONSTRAINT "tenant_usage_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security (master plan §7, §17: "a table must never exist, even
-- briefly, without its RLS policy in the same deploy").
--
-- `plans` / `add_ons` / `trial_policy` are PLATFORM-owned catalog/config —
-- exactly like `users`/`schema_meta`, they carry no `organization_id`/
-- `academy_id` and get NO RLS policy at all: every authenticated caller
-- reads the same catalog (`PlanService`'s own doc comment: "unlike
-- `TenantService` nothing here takes an `organizationId`"). Treating these
-- as organization-owned would be incorrect, not merely unnecessary — RLS
-- is a tenant-isolation mechanism, and these three tables have no tenant
-- dimension to isolate.
--
-- `tenant_subscriptions` / `tenant_add_ons` / `tenant_usage` ARE
-- organization-scoped and reuse the exact P2/P3 session variable
-- (`app.current_organization_id`, set via `TenancyContextService.
-- runInTenantContext`) — no new session variable, no second tenant
-- mechanism.
--
-- Command coverage, deliberate:
--   SELECT — tenant-scoped on all three. This is what the P4 tenant-
--     isolation suite (extending the permanent one from P2/P3) exists to
--     prove.
--   INSERT — narrow, NOT `WITH CHECK (true)` (the P2-established
--     anti-pattern), on all three, even though NO endpoint in P4 creates
--     any of these rows (`tenant_subscriptions`/`tenant_add_ons` have no
--     creation endpoint — real subscription creation is Phase P14
--     provisioning, exactly like `organizations` itself; `tenant_usage`'s
--     only writer is the `tenant-usage-recompute` worker, itself governed
--     by this same policy, not a superuser bypass). Matches P2's own
--     `organizations_insert` precedent: the policy governs the `atlas_app`
--     role itself, not which endpoints currently call it, so it lands the
--     moment the table exists, not deferred until a write endpoint does.
--     Test fixtures for `tenant_subscriptions`/`tenant_add_ons` are seeded
--     via the admin superuser connection (`test/utils/db-admin.ts`),
--     exactly like `organizations`/`academies`.
--   UPDATE — `tenant_usage` only. This is the phase that adds the
--     recompute-worker WRITE capability, so per §17 the UPDATE policy
--     lands now, matching `academies_tenant_update`'s "both USING and WITH
--     CHECK pin organization_id to the active context" shape — structurally
--     impossible for the worker (or any bug) to write one organization's
--     computed usage into another's row. No UPDATE policy on
--     `tenant_subscriptions`/`tenant_add_ons` — no endpoint updates either.
--   DELETE — none on any table, none planned.
-- ============================================================================

ALTER TABLE "tenant_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_subscriptions_tenant_select" ON "tenant_subscriptions"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "tenant_subscriptions_insert" ON "tenant_subscriptions"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

ALTER TABLE "tenant_add_ons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_add_ons" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_add_ons_tenant_select" ON "tenant_add_ons"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "tenant_add_ons_insert" ON "tenant_add_ons"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

ALTER TABLE "tenant_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_usage" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_usage_tenant_select" ON "tenant_usage"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "tenant_usage_insert" ON "tenant_usage"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "tenant_usage_tenant_update" ON "tenant_usage"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));
