-- CreateEnum
CREATE TYPE "notification_retention_class" AS ENUM ('standard', 'extended');

-- CreateEnum
CREATE TYPE "communication_category" AS ENUM ('security', 'transactional', 'lifecycle', 'engagement', 'operational');

-- CreateEnum
CREATE TYPE "communication_outbox_state" AS ENUM ('pending', 'dispatched', 'deferred', 'suppressed', 'failed');

-- CreateEnum
CREATE TYPE "communication_channel" AS ENUM ('email', 'in_app');

-- CreateEnum
CREATE TYPE "communication_delivery_status" AS ENUM ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'deferred');

-- CreateEnum
CREATE TYPE "communication_suppression_reason" AS ENUM ('hard_bounce', 'soft_bounce', 'complaint', 'manual', 'invalid');

-- CreateEnum
CREATE TYPE "communication_digest_state" AS ENUM ('open', 'sent', 'empty');

-- AlterEnum
ALTER TYPE "media_asset_status" ADD VALUE 'deleted';

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "bytes_freed" BIGINT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deletion_failed_at" TIMESTAMP(3),
ADD COLUMN     "deletion_reason" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "retention_class" "notification_retention_class" NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "tenant_add_ons" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "communication_outbox" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" "communication_category" NOT NULL,
    "recipient_user_id" TEXT,
    "recipient_invite_id" TEXT,
    "organization_id" TEXT,
    "academy_id" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "dedupe_key" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "branding" TEXT NOT NULL DEFAULT 'platform',
    "values" JSONB,
    "channels" JSONB NOT NULL,
    "priority" "notification_priority" NOT NULL DEFAULT 'medium',
    "state" "communication_outbox_state" NOT NULL DEFAULT 'pending',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "digest_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),

    CONSTRAINT "communication_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_deliveries" (
    "id" TEXT NOT NULL,
    "outbox_id" TEXT NOT NULL,
    "channel" "communication_channel" NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "status" "communication_delivery_status" NOT NULL DEFAULT 'queued',
    "error_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "template_version" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_suppressions" (
    "id" TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "email_domain" TEXT,
    "reason" "communication_suppression_reason" NOT NULL,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "communication_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_digests" (
    "id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "state" "communication_digest_state" NOT NULL DEFAULT 'open',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_email_challenges" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "academy_id" TEXT,
    "code_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resends" INTEGER NOT NULL DEFAULT 0,
    "device_fingerprint" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_email_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "user_agent" TEXT,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_lifecycle_state" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "origin" TEXT,
    "anchor_at" TIMESTAMP(3),
    "last_step" TEXT,
    "last_step_at" TIMESTAMP(3),
    "deletion_scheduled_at" TIMESTAMP(3),
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "hold_reason" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_lifecycle_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "communication_outbox_state_available_at_idx" ON "communication_outbox"("state", "available_at");

-- CreateIndex
CREATE INDEX "communication_outbox_organization_id_created_at_idx" ON "communication_outbox"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "communication_outbox_recipient_user_id_created_at_idx" ON "communication_outbox"("recipient_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "communication_outbox_recipient_user_id_dedupe_key_key" ON "communication_outbox"("recipient_user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "communication_deliveries_provider_message_id_idx" ON "communication_deliveries"("provider_message_id");

-- CreateIndex
CREATE INDEX "communication_deliveries_status_updated_at_idx" ON "communication_deliveries"("status", "updated_at");

-- CreateIndex
CREATE INDEX "communication_deliveries_outbox_id_idx" ON "communication_deliveries"("outbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_suppressions_email_hash_key" ON "communication_suppressions"("email_hash");

-- CreateIndex
CREATE INDEX "communication_suppressions_reason_created_at_idx" ON "communication_suppressions"("reason", "created_at" DESC);

-- CreateIndex
CREATE INDEX "communication_digests_state_window_end_idx" ON "communication_digests"("state", "window_end");

-- CreateIndex
CREATE UNIQUE INDEX "communication_digests_recipient_user_id_kind_window_start_key" ON "communication_digests"("recipient_user_id", "kind", "window_start");

-- CreateIndex
CREATE INDEX "auth_email_challenges_user_id_created_at_idx" ON "auth_email_challenges"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "auth_email_challenges_expires_at_idx" ON "auth_email_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices"("token_hash");

-- CreateIndex
CREATE INDEX "trusted_devices_user_id_revoked_at_idx" ON "trusted_devices"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "trusted_devices_expires_at_idx" ON "trusted_devices"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_lifecycle_state_organization_id_key" ON "tenant_lifecycle_state"("organization_id");

-- CreateIndex
CREATE INDEX "tenant_lifecycle_state_phase_deletion_scheduled_at_idx" ON "tenant_lifecycle_state"("phase", "deletion_scheduled_at");

-- AddForeignKey
ALTER TABLE "communication_outbox" ADD CONSTRAINT "communication_outbox_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_outbox" ADD CONSTRAINT "communication_outbox_digest_id_fkey" FOREIGN KEY ("digest_id") REFERENCES "communication_digests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_deliveries" ADD CONSTRAINT "communication_deliveries_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "communication_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_digests" ADD CONSTRAINT "communication_digests_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_email_challenges" ADD CONSTRAINT "auth_email_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_lifecycle_state" ADD CONSTRAINT "tenant_lifecycle_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- P64 Communications & Lifecycle — foundation (C0/C1/C4/C5/C6 schema, additive)
--
-- RLS discipline unchanged from P17/P64: FORCE RLS on every new table; the
-- writer is always a trusted server-side effect on behalf of another user
-- (`*_system_insert WITH CHECK (true)`, mirroring `notifications` and
-- `audit_log_entries`); a person reads only their own rows through the
-- user GUC; tenant staff read their organisation's rows through the tenant
-- GUC; the platform owner reads/updates everything through
-- `is_platform_owner(app.current_user_id)`. The dispatcher and sweeps run
-- under the platform-owner user context (the established sweep precedent),
-- never without a context. Retention deletes are bounded by their own
-- DELETE policies exactly like `content_access_log_retention_delete`.
-- =============================================================================

-- ---- communication_outbox --------------------------------------------------
ALTER TABLE "communication_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_outbox_self_select" ON "communication_outbox"
  FOR SELECT USING ("recipient_user_id"::text = current_setting('app.current_user_id', true));
CREATE POLICY "communication_outbox_tenant_select" ON "communication_outbox"
  FOR SELECT USING ("organization_id" IS NOT NULL AND "organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "communication_outbox_platform_select" ON "communication_outbox"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_outbox_platform_update" ON "communication_outbox"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_outbox_system_insert" ON "communication_outbox"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "communication_outbox_retention_delete" ON "communication_outbox"
  FOR DELETE USING ("created_at" < now() - INTERVAL '90 days');

-- ---- communication_deliveries ----------------------------------------------
ALTER TABLE "communication_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_deliveries_platform_select" ON "communication_deliveries"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_deliveries_tenant_select" ON "communication_deliveries"
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM "communication_outbox" o
    WHERE o."id" = "communication_deliveries"."outbox_id"
      AND o."organization_id" IS NOT NULL
      AND o."organization_id"::text = current_setting('app.current_organization_id', true)));
CREATE POLICY "communication_deliveries_platform_update" ON "communication_deliveries"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_deliveries_system_insert" ON "communication_deliveries"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "communication_deliveries_retention_delete" ON "communication_deliveries"
  FOR DELETE USING ("created_at" < now() - INTERVAL '90 days');

-- ---- communication_suppressions (platform data) ----------------------------
ALTER TABLE "communication_suppressions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_suppressions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_suppressions_platform_all" ON "communication_suppressions"
  FOR ALL USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_suppressions_system_insert" ON "communication_suppressions"
  FOR INSERT WITH CHECK (true);

-- ---- communication_digests -------------------------------------------------
ALTER TABLE "communication_digests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "communication_digests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "communication_digests_self_select" ON "communication_digests"
  FOR SELECT USING ("recipient_user_id"::text = current_setting('app.current_user_id', true));
CREATE POLICY "communication_digests_platform_select" ON "communication_digests"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_digests_platform_update" ON "communication_digests"
  FOR UPDATE USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "communication_digests_system_insert" ON "communication_digests"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "communication_digests_retention_delete" ON "communication_digests"
  FOR DELETE USING ("created_at" < now() - INTERVAL '90 days');

-- ---- auth_email_challenges (server-side only; no user read) ----------------
ALTER TABLE "auth_email_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_email_challenges" FORCE ROW LEVEL SECURITY;
CREATE POLICY "auth_email_challenges_system_insert" ON "auth_email_challenges"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "auth_email_challenges_system_select" ON "auth_email_challenges"
  FOR SELECT USING (true);
CREATE POLICY "auth_email_challenges_system_update" ON "auth_email_challenges"
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "auth_email_challenges_retention_delete" ON "auth_email_challenges"
  FOR DELETE USING ("created_at" < now() - INTERVAL '24 hours');

-- ---- trusted_devices -------------------------------------------------------
ALTER TABLE "trusted_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trusted_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "trusted_devices_self_select" ON "trusted_devices"
  FOR SELECT USING ("user_id"::text = current_setting('app.current_user_id', true));
CREATE POLICY "trusted_devices_self_update" ON "trusted_devices"
  FOR UPDATE USING ("user_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id"::text = current_setting('app.current_user_id', true));
CREATE POLICY "trusted_devices_platform_select" ON "trusted_devices"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "trusted_devices_system_insert" ON "trusted_devices"
  FOR INSERT WITH CHECK (true);
CREATE POLICY "trusted_devices_system_select" ON "trusted_devices"
  FOR SELECT USING (true);
CREATE POLICY "trusted_devices_system_update" ON "trusted_devices"
  FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "trusted_devices_retention_delete" ON "trusted_devices"
  FOR DELETE USING ("expires_at" < now() - INTERVAL '30 days');

-- ---- tenant_lifecycle_state ------------------------------------------------
ALTER TABLE "tenant_lifecycle_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_lifecycle_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_lifecycle_state_tenant_select" ON "tenant_lifecycle_state"
  FOR SELECT USING ("organization_id"::text = current_setting('app.current_organization_id', true));
CREATE POLICY "tenant_lifecycle_state_platform_all" ON "tenant_lifecycle_state"
  FOR ALL USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
CREATE POLICY "tenant_lifecycle_state_system_insert" ON "tenant_lifecycle_state"
  FOR INSERT WITH CHECK (true);

-- ---- notifications: retention delete bounded by class ------------------------
CREATE POLICY "notifications_retention_delete" ON "notifications"
  FOR DELETE USING (
    ("retention_class" = 'standard' AND "created_at" < now() - INTERVAL '180 days')
    OR ("retention_class" = 'extended' AND "created_at" < now() - INTERVAL '365 days'));
