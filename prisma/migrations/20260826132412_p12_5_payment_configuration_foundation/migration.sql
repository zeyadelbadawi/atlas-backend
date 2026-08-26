-- CreateEnum
CREATE TYPE "payment_collection_mode" AS ENUM ('unconfigured', 'atlas_payments', 'organization_gateway');

-- CreateEnum
CREATE TYPE "organization_gateway_credential_status" AS ENUM ('not_configured', 'configured', 'verified', 'disabled');

-- CreateEnum
CREATE TYPE "organization_connected_account_onboarding_status" AS ENUM ('not_started', 'pending', 'action_required', 'verified', 'restricted', 'disabled');

-- CreateEnum
CREATE TYPE "organization_commission_mode" AS ENUM ('default', 'custom', 'exempt');

-- CreateTable
CREATE TABLE "organization_payment_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "payment_collection_mode" "payment_collection_mode" NOT NULL DEFAULT 'unconfigured',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_gateway_credentials" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "status" "organization_gateway_credential_status" NOT NULL DEFAULT 'not_configured',
    "encrypted_config" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_tested_at" TIMESTAMP(3),
    "last_test_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_gateway_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_connected_accounts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "provider_key" TEXT,
    "external_account_reference" TEXT,
    "onboarding_status" "organization_connected_account_onboarding_status" NOT NULL DEFAULT 'not_started',
    "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_connected_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_commission_settings" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "commission_mode" "organization_commission_mode" NOT NULL DEFAULT 'default',
    "custom_percentage_basis_points" INTEGER,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_commission_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "atlas_commission_config" (
    "id" TEXT NOT NULL,
    "default_commission_basis_points" INTEGER,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "atlas_commission_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_payment_settings_organization_id_key" ON "organization_payment_settings"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_gateway_credentials_organization_id_key" ON "organization_gateway_credentials"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_connected_accounts_organization_id_key" ON "organization_connected_accounts"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_commission_settings_organization_id_key" ON "organization_commission_settings"("organization_id");

-- AddForeignKey
ALTER TABLE "organization_payment_settings" ADD CONSTRAINT "organization_payment_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_gateway_credentials" ADD CONSTRAINT "organization_gateway_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_connected_accounts" ADD CONSTRAINT "organization_connected_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_commission_settings" ADD CONSTRAINT "organization_commission_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_commission_settings" ADD CONSTRAINT "organization_commission_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atlas_commission_config" ADD CONSTRAINT "atlas_commission_config_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Row-Level Security — Organization Payment Configuration (master plan
-- §5.8, §7, §16; product decisions §4.1/§4.2, 2026-08-26). Prerequisite to
-- Phase P13 — no `course_orders`/`revenue_ledger_entries`/payout table
-- exists yet, this is configuration only.
--
-- No new `SECURITY DEFINER` function is introduced by this migration — both
-- reused predicates (`current_setting('app.current_organization_id', true)`
-- and `is_platform_owner(current_setting('app.current_user_id', true))`)
-- already exist from P2/P12 respectively.
--
-- Command coverage, deliberate, table-by-table (mirrors every prior
-- phase's own reasoning table):
--
--   `organization_payment_settings` / `organization_gateway_credentials` /
--   `organization_connected_accounts` — ordinary tenant-isolated
--   configuration, same shape as every other Organization-owned settings
--   table in this codebase: SELECT/INSERT/UPDATE narrowly scoped to
--   `app.current_organization_id`, no platform-review policy (Platform
--   Owner has no product-specified need to read an Organization's own
--   gateway credentials or connected-account reference), no DELETE
--   anywhere (upsert-style writes only, matching every other phase's
--   append/update-only convention).
--
--   IMPORTANT: RLS is row-level, not column-level — it cannot itself hide
--   `organization_gateway_credentials.encrypted_config` from a query that
--   is otherwise allowed to read the row. The real control keeping
--   `encrypted_config` out of every normal API response is application-
--   layer: `OrganizationGatewayCredentialsRepository` never selects that
--   column on any read path used by a response DTO, matching
--   `payment_proofs.storage_key`'s identical "private, backend-internal-
--   only column" precedent (§13) — RLS's job here is tenant isolation
--   only, not secret redaction.
--
--   `organization_commission_settings` — THE table where write access is
--   deliberately NOT symmetric with read access, per §4.2's explicit
--   requirement ("an Organization must not be able to grant itself a
--   commission exemption or modify its own rate"). An Organization gets a
--   narrow SELECT-only policy on its own row (visibility). NO tenant
--   INSERT/UPDATE policy exists AT ALL for the `atlas_app` role — the only
--   INSERT/UPDATE policies are `is_platform_owner`-gated, identical in
--   shape to P12's `payments_platform_review_update`. This is the concrete
--   database-level enforcement of §4.2's rule, not merely an application-
--   layer convention that a future bug could bypass.
--
--   `atlas_commission_config` — platform-owned singleton, no RLS at all
--   (mirrors `platform_domain_configuration`/`trial_policy`'s identical
--   "not tenant data" precedent). `PlatformOwnerGuard` at the controller
--   layer is the sole write gate, same as `PlatformDomainController`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- organization_payment_settings
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_payment_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_payment_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_payment_settings_tenant_select" ON "organization_payment_settings"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_payment_settings_tenant_insert" ON "organization_payment_settings"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_payment_settings_tenant_update" ON "organization_payment_settings"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- organization_gateway_credentials
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_gateway_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_gateway_credentials" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_gateway_credentials_tenant_select" ON "organization_gateway_credentials"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_gateway_credentials_tenant_insert" ON "organization_gateway_credentials"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_gateway_credentials_tenant_update" ON "organization_gateway_credentials"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- organization_connected_accounts
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_connected_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_connected_accounts" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_connected_accounts_tenant_select" ON "organization_connected_accounts"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_connected_accounts_tenant_insert" ON "organization_connected_accounts"
  FOR INSERT
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_connected_accounts_tenant_update" ON "organization_connected_accounts"
  FOR UPDATE
  USING ("organization_id"::text = current_setting('app.current_organization_id', true))
  WITH CHECK ("organization_id"::text = current_setting('app.current_organization_id', true));

-- ---------------------------------------------------------------------------
-- organization_commission_settings — asymmetric read/write, see header.
-- ---------------------------------------------------------------------------

ALTER TABLE "organization_commission_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_commission_settings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_commission_settings_tenant_select" ON "organization_commission_settings"
  FOR SELECT
  USING ("organization_id"::text = current_setting('app.current_organization_id', true));

CREATE POLICY "organization_commission_settings_platform_select" ON "organization_commission_settings"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "organization_commission_settings_platform_insert" ON "organization_commission_settings"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "organization_commission_settings_platform_update" ON "organization_commission_settings"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- atlas_commission_config: platform-owned singleton, no RLS — see header comment.
