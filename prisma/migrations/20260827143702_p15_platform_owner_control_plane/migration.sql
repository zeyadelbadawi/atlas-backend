-- CreateEnum
CREATE TYPE "support_case_status" AS ENUM ('open', 'in_progress', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "support_case_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "support_case_message_author_role" AS ENUM ('requester', 'agent');

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_label" TEXT,
    "context" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_cases" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT,
    "requester_user_id" TEXT,
    "subject" TEXT NOT NULL,
    "status" "support_case_status" NOT NULL DEFAULT 'open',
    "priority" "support_case_priority" NOT NULL DEFAULT 'medium',
    "requester_name" TEXT NOT NULL,
    "requester_email" TEXT NOT NULL,
    "assigned_to_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_case_messages" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_role" "support_case_message_author_role" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_case_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL,
    "platform_name" TEXT NOT NULL,
    "platform_description" TEXT,
    "support_email" TEXT,
    "two_factor_required" BOOLEAN NOT NULL DEFAULT false,
    "session_timeout_minutes" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_entries_occurred_at_idx" ON "audit_log_entries"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entries_organization_id_occurred_at_idx" ON "audit_log_entries"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entries_target_type_target_id_idx" ON "audit_log_entries"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "support_cases_status_created_at_idx" ON "support_cases"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_organization_id_idx" ON "support_cases"("organization_id");

-- CreateIndex
CREATE INDEX "support_case_messages_case_id_created_at_idx" ON "support_case_messages"("case_id", "created_at" ASC);

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_case_messages" ADD CONSTRAINT "support_case_messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- Phase P15 — Platform Owner Control Plane RLS
-- =============================================================================
--
-- Part 1: narrow, additive `_platform_select` policies on EXISTING tenant
-- tables — the "explicit, role-scoped, narrowly implemented" Platform
-- Owner bypass master plan §7 point 4 requires, reusing the EXISTING
-- `is_platform_owner(text)` SECURITY DEFINER function (P12) verbatim, no
-- new function needed. Every one of these is Postgres's own "multiple
-- PERMISSIVE policies for one command are OR'd together" rule at work —
-- the existing tenant-scoped SELECT policy on each of these tables is
-- completely untouched; a normal tenant user's access is byte-for-byte
-- identical to before this migration. Read under
-- `TenancyContextService.runInUserContext(platformOwnerUserId)` — no
-- `app.current_organization_id` is ever set for these reads, so only the
-- new policy (never the existing org-scoped one, which would see nothing
-- without that variable) makes a cross-tenant row visible.
--
-- Part 2: three new Platform-owned tables (`audit_log_entries`,
-- `support_cases`/`support_case_messages`, real RLS; `platform_settings`,
-- no RLS — matches `platform_domain_configuration`/`trial_policy`'s own
-- precedent for a single global config row, see schema.prisma's own P15
-- header comment for the full reasoning).

-- ---------------------------------------------------------------------------
-- Part 1 — cross-tenant platform-select policies on existing tables
-- ---------------------------------------------------------------------------

CREATE POLICY "organizations_platform_select" ON "organizations"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "organization_memberships_platform_select" ON "organization_memberships"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academies_platform_select" ON "academies"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "academy_members_platform_select" ON "academy_members"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "courses_platform_select" ON "courses"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "tenant_subscriptions_platform_select" ON "tenant_subscriptions"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "tenant_usage_platform_select" ON "tenant_usage"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "domain_connections_platform_select" ON "domain_connections"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "website_configurations_platform_select" ON "website_configurations"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- Part 2 — new Platform-owned tables
-- ---------------------------------------------------------------------------

ALTER TABLE "audit_log_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log_entries" FORCE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_entries_platform_select" ON "audit_log_entries"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- Deliberately `WITH CHECK (true)` — NOT a blanket RLS bypass, an
-- explicit, narrow, documented exception for this ONE table's ONE
-- command. `audit_log_entries` is written by `AuditLogWriterService` from
-- inside dozens of different business mutations across every phase, each
-- already running under whatever RLS context (`runInTenantContext`/
-- `runInUserContext`/`runInTenantAndUserContext`) that mutation's own
-- transaction needs — frequently with NO `app.current_user_id` set at
-- all (e.g. `AcademiesService.create` runs under `runInTenantContext`
-- only). The real authorization boundary for "who may write an audit
-- row" is the application layer: `AuditLogWriterService` is never called
-- with client-controlled input, only from server-side service code after
-- its own business authorization has already succeeded — matching
-- "backend is the sole writer" (master plan §5.12) exactly. RLS's actual
-- job on this table — preventing cross-tenant READ — remains fully
-- enforced by the SELECT policy above, unchanged.
CREATE POLICY "audit_log_entries_insert" ON "audit_log_entries"
  FOR INSERT
  WITH CHECK (true);

ALTER TABLE "support_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_cases" FORCE ROW LEVEL SECURITY;

CREATE POLICY "support_cases_platform_select" ON "support_cases"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- No INSERT policy — deliberately. There is no create-case endpoint in
-- this phase (master plan §24: "Support case creation from the dashboard
-- | SPECIFICATION-UNDEFINED | No creation endpoint in any frontend
-- contract"); every row is provisioned outside this table's application
-- write path (fixture/seed/future channel, via the migration-superuser
-- connection, which bypasses RLS entirely for that purpose — see
-- `test/utils/db-admin.ts`'s own precedent). Omitting the policy here
-- means `atlas_app` genuinely cannot insert a row through this table
-- under ANY context — matching the implemented capability exactly,
-- rather than granting a permission no code path ever exercises.

CREATE POLICY "support_cases_platform_update" ON "support_cases"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

ALTER TABLE "support_case_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY "support_case_messages_platform_select" ON "support_case_messages"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "support_case_messages_platform_insert" ON "support_case_messages"
  FOR INSERT
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- `platform_settings` — deliberately NO RLS. Matches
-- `platform_domain_configuration`/`trial_policy`'s own identical,
-- pre-existing precedent: a single global config row is Platform-owned
-- but not tenant data, and `PlatformOwnerGuard` at the application layer
-- (the same guard those two tables already rely on exclusively) is the
-- real, sufficient, already-established protection — see
-- `schema.prisma`'s own P15 header comment.
