-- CreateEnum
CREATE TYPE "tenant_add_on_status" AS ENUM ('installing', 'installed', 'enabled', 'disabled', 'uninstalling', 'uninstalled', 'failed');

-- CreateEnum
CREATE TYPE "live_provider_key" AS ENUM ('zoom');

-- CreateEnum
CREATE TYPE "live_provider_connection_status" AS ENUM ('not_connected', 'connected', 'expired', 'revoked', 'error');

-- CreateEnum
CREATE TYPE "live_session_status" AS ENUM ('draft', 'scheduled', 'live', 'ended', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "live_attendance_source" AS ENUM ('sdk_event', 'provider_webhook', 'provider_report', 'manual');

-- CreateEnum
CREATE TYPE "live_session_recording_status" AS ENUM ('requested', 'processing', 'available', 'failed');

-- CreateEnum
CREATE TYPE "live_provider_event_status" AS ENUM ('received', 'processed', 'unmatched', 'failed');

-- DropIndex
DROP INDEX "academies_search_vector_idx";

-- DropIndex
DROP INDEX "courses_search_vector_idx";

-- DropIndex
DROP INDEX "organizations_search_vector_idx";

-- DropIndex
DROP INDEX "users_deleted_at_idx";

-- DropIndex
DROP INDEX "users_search_vector_idx";

-- AlterTable
ALTER TABLE "academies" DROP COLUMN "search_vector";

-- AlterTable
ALTER TABLE "courses" DROP COLUMN "search_vector";

-- AlterTable
ALTER TABLE "organizations" DROP COLUMN "search_vector";

-- AlterTable
ALTER TABLE "tenant_add_ons" ADD COLUMN     "disabled_at" TIMESTAMP(3),
ADD COLUMN     "enabled_at" TIMESTAMP(3),
ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "installed_at" TIMESTAMP(3),
ADD COLUMN     "status" "tenant_add_on_status" NOT NULL DEFAULT 'enabled',
ADD COLUMN     "uninstalled_at" TIMESTAMP(3),
-- DEFAULT is load-bearing, not cosmetic. `ADD COLUMN ... NOT NULL` with no
-- default ABORTS on a table that already has rows, and `tenant_add_ons`
-- holds a row for every add-on any tenant has ever activated. The generated
-- DDL was safe only against the empty local table it was diffed against;
-- on production it would have failed the whole deploy. Existing rows get
-- the migration timestamp, which is the honest answer for "when was this
-- row last touched" given the column did not exist before now.
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "search_vector";

-- CreateTable
CREATE TABLE "academy_live_provider_connections" (
    "id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "provider_key" "live_provider_key" NOT NULL DEFAULT 'zoom',
    "status" "live_provider_connection_status" NOT NULL DEFAULT 'not_connected',
    "encrypted_credentials" TEXT,
    "external_account_id" TEXT,
    "last_check_result" JSONB,
    "last_checked_at" TIMESTAMP(3),
    "connected_by_user_id" TEXT,
    "connected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "academy_live_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" TEXT NOT NULL,
    "course_id" TEXT NOT NULL,
    "section_id" TEXT,
    "academy_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" "live_session_status" NOT NULL DEFAULT 'draft',
    "scheduled_start_at" TIMESTAMP(3) NOT NULL,
    "scheduled_end_at" TIMESTAMP(3) NOT NULL,
    "host_user_id" TEXT NOT NULL,
    "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider_key" "live_provider_key" NOT NULL DEFAULT 'zoom',
    "provider_meeting_id" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_participants" (
    "id" TEXT NOT NULL,
    "live_session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "participant_key" TEXT NOT NULL,
    "provider_participant_id" TEXT,
    "role" TEXT NOT NULL DEFAULT 'attendee',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_attendance_intervals" (
    "id" TEXT NOT NULL,
    "live_session_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    "source" "live_attendance_source" NOT NULL,
    "event_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_session_attendance_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_recordings" (
    "id" TEXT NOT NULL,
    "live_session_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "live_session_recording_status" NOT NULL DEFAULT 'requested',
    "provider_recording_id" TEXT,
    "quota_consumed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "available_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_session_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_recording_files" (
    "id" TEXT NOT NULL,
    "recording_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "provider_file_id" TEXT NOT NULL,
    "media_asset_id" TEXT,
    "file_type" TEXT,
    "size_bytes" BIGINT,
    "imported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_session_recording_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_join_grants" (
    "id" TEXT NOT NULL,
    "live_session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'attendee',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_session_join_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_provider_events" (
    "id" TEXT NOT NULL,
    "provider_key" "live_provider_key" NOT NULL DEFAULT 'zoom',
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" "live_provider_event_status" NOT NULL DEFAULT 'received',
    "academy_id" TEXT,
    "live_session_id" TEXT,
    "summary" JSONB,
    "failure_reason" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "live_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "academy_live_provider_connections_academy_id_key" ON "academy_live_provider_connections"("academy_id");

-- CreateIndex
CREATE INDEX "academy_live_provider_connections_provider_key_external_acc_idx" ON "academy_live_provider_connections"("provider_key", "external_account_id");

-- CreateIndex
CREATE INDEX "live_sessions_course_id_section_id_order_idx" ON "live_sessions"("course_id", "section_id", "order");

-- CreateIndex
CREATE INDEX "live_sessions_academy_id_status_scheduled_start_at_idx" ON "live_sessions"("academy_id", "status", "scheduled_start_at");

-- CreateIndex
CREATE INDEX "live_sessions_provider_key_provider_meeting_id_idx" ON "live_sessions"("provider_key", "provider_meeting_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_participants_participant_key_key" ON "live_session_participants"("participant_key");

-- CreateIndex
CREATE INDEX "live_session_participants_live_session_id_idx" ON "live_session_participants"("live_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_participants_live_session_id_user_id_key" ON "live_session_participants"("live_session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_attendance_intervals_event_key_key" ON "live_session_attendance_intervals"("event_key");

-- CreateIndex
CREATE INDEX "live_session_attendance_intervals_live_session_id_participa_idx" ON "live_session_attendance_intervals"("live_session_id", "participant_id", "joined_at");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_recordings_live_session_id_key" ON "live_session_recordings"("live_session_id");

-- CreateIndex
CREATE INDEX "live_session_recordings_organization_id_quota_consumed_at_idx" ON "live_session_recordings"("organization_id", "quota_consumed_at");

-- CreateIndex
CREATE INDEX "live_session_recordings_academy_id_status_idx" ON "live_session_recordings"("academy_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_recording_files_recording_id_provider_file_id_key" ON "live_session_recording_files"("recording_id", "provider_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_join_grants_token_hash_key" ON "live_session_join_grants"("token_hash");

-- CreateIndex
CREATE INDEX "live_session_join_grants_live_session_id_user_id_idx" ON "live_session_join_grants"("live_session_id", "user_id");

-- CreateIndex
CREATE INDEX "live_session_join_grants_expires_at_idx" ON "live_session_join_grants"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "live_provider_events_provider_event_id_key" ON "live_provider_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "live_provider_events_status_received_at_idx" ON "live_provider_events"("status", "received_at");

-- CreateIndex
CREATE INDEX "live_provider_events_live_session_id_idx" ON "live_provider_events"("live_session_id");

-- CreateIndex
CREATE INDEX "tenant_add_ons_organization_id_status_idx" ON "tenant_add_ons"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "academy_live_provider_connections" ADD CONSTRAINT "academy_live_provider_connections_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_live_provider_connections" ADD CONSTRAINT "academy_live_provider_connections_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "course_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_participants" ADD CONSTRAINT "live_session_participants_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_participants" ADD CONSTRAINT "live_session_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_attendance_intervals" ADD CONSTRAINT "live_session_attendance_intervals_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_attendance_intervals" ADD CONSTRAINT "live_session_attendance_intervals_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "live_session_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_recordings" ADD CONSTRAINT "live_session_recordings_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_recording_files" ADD CONSTRAINT "live_session_recording_files_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "live_session_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_recording_files" ADD CONSTRAINT "live_session_recording_files_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- ROW LEVEL SECURITY — Phase 12, Live Sessions add-on.
--
-- GUARD DECIDES, RLS INDEPENDENTLY AGREES. Every route below is already
-- gated by `AcademyScopeGuard`/`OrganizationMembershipGuard` and by the
-- add-on entitlement check; these policies are the second, independent
-- layer underneath that, not the only one.
--
-- TWO AUDIENCES, TWO POLICY FAMILIES, exactly as `course_lessons` already
-- models:
--
--   * STAFF (owners/managers/instructors) act inside
--     `app.current_organization_id` and reach rows transitively through
--     `academies.organization_id` — the identical predicate
--     `media_assets` uses.
--   * STUDENTS are never organization members, so they act under
--     `app.current_user_id` (the P6 mechanism) and reach a session ONLY
--     through an `enrollments` row of their own for that course. This is
--     what makes cross-academy and not-enrolled access fail at the
--     database even if a guard were somehow bypassed.
--
-- Students get SELECT and nothing else, and only on `live_sessions` and
-- their OWN attendance. They can never see another student's intervals,
-- the provider connection, join grants, or recordings — recordings remain
-- governed by the existing media authorization, which attending a session
-- does not alter.
--
-- No DELETE policy anywhere: sessions are cancelled (a status), never
-- hard-deleted, matching `courses`/`media_assets`' identical precedent.
--
-- NOTE ON PRIVILEGES. No GRANT statements are needed. The P2 migration's
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO atlas_app`
-- already covers every table a later migration creates as the superuser.
-- ============================================================================
ALTER TABLE "academy_live_provider_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academy_live_provider_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_session_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_session_participants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_session_attendance_intervals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_session_attendance_intervals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_session_recordings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_session_recordings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_session_recording_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_session_recording_files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "live_session_join_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "live_session_join_grants" FORCE ROW LEVEL SECURITY;

CREATE POLICY "academy_live_provider_connections_tenant_select" ON "academy_live_provider_connections"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_live_provider_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "academy_live_provider_connections_tenant_insert" ON "academy_live_provider_connections"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_live_provider_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "academy_live_provider_connections_tenant_update" ON "academy_live_provider_connections"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_live_provider_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "academy_live_provider_connections"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_sessions_tenant_select" ON "live_sessions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_sessions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_sessions_tenant_insert" ON "live_sessions"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_sessions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_sessions_tenant_update" ON "live_sessions"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_sessions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_sessions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_participants_tenant_select" ON "live_session_participants"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_participants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_participants_tenant_insert" ON "live_session_participants"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_participants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_participants_tenant_update" ON "live_session_participants"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_participants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_participants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_attendance_intervals_tenant_select" ON "live_session_attendance_intervals"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_attendance_intervals"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_attendance_intervals_tenant_insert" ON "live_session_attendance_intervals"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_attendance_intervals"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_attendance_intervals_tenant_update" ON "live_session_attendance_intervals"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_attendance_intervals"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_attendance_intervals"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recordings_tenant_select" ON "live_session_recordings"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recordings"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recordings_tenant_insert" ON "live_session_recordings"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recordings"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recordings_tenant_update" ON "live_session_recordings"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recordings"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recordings"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recording_files_tenant_select" ON "live_session_recording_files"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recording_files"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recording_files_tenant_insert" ON "live_session_recording_files"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recording_files"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_recording_files_tenant_update" ON "live_session_recording_files"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recording_files"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_recording_files"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_join_grants_tenant_select" ON "live_session_join_grants"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_join_grants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_join_grants_tenant_insert" ON "live_session_join_grants"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_join_grants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

CREATE POLICY "live_session_join_grants_tenant_update" ON "live_session_join_grants"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_join_grants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "live_session_join_grants"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );

-- ---------------------------------------------------------------------------
-- Student access. Additive and narrow, OR'd alongside the tenant policies
-- above — never replacing them. A student reaches a session only through an
-- `enrollments` row that is THEIRS, for THAT course. Not enrolled, or
-- enrolled in a different academy's course, and the row simply does not
-- exist for them.
--
-- `draft` sessions are excluded: an unpublished activity is not yet part of
-- the curriculum a student should see, matching how `course_lessons`
-- treats its own draft status.
-- ---------------------------------------------------------------------------

CREATE POLICY "live_sessions_enrolled_student_select" ON "live_sessions"
  FOR SELECT
  USING (
    "live_sessions"."status" <> 'draft'
    AND EXISTS (
      SELECT 1 FROM "enrollments" e
      WHERE e."course_id" = "live_sessions"."course_id"
        AND e."academy_id" = "live_sessions"."academy_id"
        AND e."student_id"::text = current_setting('app.current_user_id', true)
        -- Only a real relationship counts. `available`/`pending`/
        -- `unavailable` describe the catalog offer, not enrolment, and a
        -- looser predicate here would make RLS quietly weaker than the
        -- service it is meant to independently agree with.
        AND e."status" IN ('enrolled', 'completed')
    )
  );

-- A student may see their OWN attendance and nobody else's. The participant
-- row is the identity link, so this is an exact match, never a name.
CREATE POLICY "live_session_participants_self_select" ON "live_session_participants"
  FOR SELECT
  USING (
    "live_session_participants"."user_id"::text = current_setting('app.current_user_id', true)
  );

CREATE POLICY "live_session_attendance_self_select" ON "live_session_attendance_intervals"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "live_session_participants" p
      WHERE p."id" = "live_session_attendance_intervals"."participant_id"
        AND p."user_id"::text = current_setting('app.current_user_id', true)
    )
  );

-- A join grant is readable only by the person it was minted for. It is
-- never listed, only redeemed.
CREATE POLICY "live_session_join_grants_self_select" ON "live_session_join_grants"
  FOR SELECT
  USING (
    "live_session_join_grants"."user_id"::text = current_setting('app.current_user_id', true)
  );

-- ---------------------------------------------------------------------------
-- `live_provider_events` is PLATFORM-OWNED, not tenant-owned — the same
-- position `payment_webhook_events` occupies. A webhook arrives with no
-- tenant context at all (it is authenticated by signature, not by session),
-- so the row is written by the system before any tenant is known, and the
-- academy is resolved FROM stored provider identifiers rather than from
-- anything the request claimed. No tenant policy can express that, and
-- inventing one would mean trusting a tenant id supplied by an external
-- caller — precisely what must never happen.
-- ---------------------------------------------------------------------------
-- Phase 12 — `tenant_add_ons` gains its first UPDATE path.
--
-- The table shipped in P4 with SELECT + INSERT policies only, which was
-- correct then: an add-on was activated once and never changed. Giving it
-- a real lifecycle (install -> enabled -> disabled -> uninstalled) makes
-- UPDATE a genuine operation, and without a policy Postgres silently
-- matched ZERO rows — the transition appeared to succeed and changed
-- nothing.
--
-- Exactly the same shape and reasoning as the P12 migration's
-- `tenant_subscriptions_tenant_update`: the tenant may update only their
-- own row, proved by `organization_id` against the session's tenant
-- context, with the identical predicate on both USING and WITH CHECK so a
-- row cannot be updated INTO another tenant.
CREATE POLICY "tenant_add_ons_tenant_update" ON "tenant_add_ons"
  FOR UPDATE
  USING (
    "organization_id"::text = current_setting('app.current_organization_id', true)
  )
  WITH CHECK (
    "organization_id"::text = current_setting('app.current_organization_id', true)
  );
