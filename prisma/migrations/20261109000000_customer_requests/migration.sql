-- Customer Requests — custom services (logo, domain, theme, custom section,
-- custom feature) an academy's owner/administrator asks the Atlas team for.
--
-- customer_requests          one row per request, owned by an academy
-- customer_request_events    its history AND conversation, one timeline;
--                            `internal` rows (team notes, assignment) are
--                            never readable by a tenant — enforced HERE
-- customer_request_routing_rules  request type → responsible team inbox,
--                            configured by Platform Owners only
-- communication_outbox.recipient_email  an address recipient (that team
--                            inbox) for the existing outbox pipeline, so
--                            routing emails get its retries and dedupe.

-- CreateEnum
CREATE TYPE "customer_request_type" AS ENUM ('logo', 'domain', 'theme', 'custom_section', 'custom_feature');

-- CreateEnum
CREATE TYPE "customer_request_status" AS ENUM ('submitted', 'received', 'under_review', 'in_progress', 'waiting_for_customer', 'completed', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "customer_request_priority" AS ENUM ('low', 'normal', 'high');

-- CreateEnum
CREATE TYPE "customer_request_event_kind" AS ENUM ('created', 'status_changed', 'assigned', 'customer_message', 'team_message', 'internal_note');

-- CreateEnum
CREATE TYPE "customer_request_event_visibility" AS ENUM ('customer', 'internal');

-- AlterTable
ALTER TABLE "communication_outbox" ADD COLUMN     "recipient_email" TEXT;

-- CreateTable
CREATE TABLE "customer_requests" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "academy_id" TEXT NOT NULL,
    "requester_user_id" TEXT,
    "requester_name" TEXT NOT NULL,
    "requester_email" TEXT NOT NULL,
    "type" "customer_request_type" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "customer_request_priority" NOT NULL DEFAULT 'normal',
    "details" JSONB NOT NULL DEFAULT '{}',
    "status" "customer_request_status" NOT NULL DEFAULT 'submitted',
    "assigned_to_user_id" TEXT,
    "client_request_id" TEXT NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_request_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "customer_request_event_kind" NOT NULL,
    "visibility" "customer_request_event_visibility" NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT NOT NULL,
    "actor_side" TEXT NOT NULL,
    "body" TEXT,
    "from_status" "customer_request_status",
    "to_status" "customer_request_status",
    "assignee_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_request_routing_rules" (
    "type" "customer_request_type" NOT NULL,
    "email" TEXT NOT NULL,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_request_routing_rules_pkey" PRIMARY KEY ("type")
);

-- CreateIndex
CREATE INDEX "customer_requests_academy_id_last_activity_at_idx" ON "customer_requests"("academy_id", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "customer_requests_status_last_activity_at_idx" ON "customer_requests"("status", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "customer_requests_type_last_activity_at_idx" ON "customer_requests"("type", "last_activity_at" DESC);

-- CreateIndex
CREATE INDEX "customer_requests_organization_id_idx" ON "customer_requests"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_requests_requester_user_id_client_request_id_key" ON "customer_requests"("requester_user_id", "client_request_id");

-- CreateIndex
CREATE INDEX "customer_request_events_request_id_created_at_idx" ON "customer_request_events"("request_id", "created_at" ASC);

-- AddForeignKey
ALTER TABLE "customer_requests" ADD CONSTRAINT "customer_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requests" ADD CONSTRAINT "customer_requests_academy_id_fkey" FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requests" ADD CONSTRAINT "customer_requests_requester_user_id_fkey" FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_requests" ADD CONSTRAINT "customer_requests_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_request_events" ADD CONSTRAINT "customer_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "customer_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Bounds the API enforces, held by the database too.
ALTER TABLE "customer_requests"
  ADD CONSTRAINT "customer_requests_title_length_check" CHECK (char_length("title") BETWEEN 3 AND 160),
  ADD CONSTRAINT "customer_requests_description_length_check" CHECK (char_length("description") BETWEEN 10 AND 5000),
  ADD CONSTRAINT "customer_requests_details_object_check" CHECK (jsonb_typeof("details") = 'object');

ALTER TABLE "customer_request_events"
  ADD CONSTRAINT "customer_request_events_actor_side_check" CHECK ("actor_side" IN ('customer', 'team')),
  ADD CONSTRAINT "customer_request_events_body_length_check" CHECK ("body" IS NULL OR char_length("body") <= 5000),
  -- Team notes and assignment are internal by construction.
  ADD CONSTRAINT "customer_request_events_internal_kinds_check"
    CHECK ("kind" NOT IN ('internal_note', 'assigned') OR "visibility" = 'internal');

ALTER TABLE "customer_request_routing_rules"
  ADD CONSTRAINT "customer_request_routing_rules_email_check"
    CHECK (char_length("email") BETWEEN 3 AND 320 AND position('@' IN "email") > 1);

-- An address recipient is the alternative to a user recipient, never both,
-- and it dedupes exactly like a user recipient does.
ALTER TABLE "communication_outbox"
  ADD CONSTRAINT "communication_outbox_recipient_email_check"
    CHECK ("recipient_email" IS NULL OR ("recipient_user_id" IS NULL AND char_length("recipient_email") <= 320));
CREATE UNIQUE INDEX "communication_outbox_recipient_email_dedupe_key_key"
  ON "communication_outbox"("recipient_email", "dedupe_key")
  WHERE "recipient_email" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS: customer_requests
-- ---------------------------------------------------------------------------
-- Tenant: the academy's organization (the route guard narrows it to the
-- academy's owner/administrator). A tenant can insert only its own,
-- untriaged, unassigned request for an academy of its own organization.
-- Platform Owners read and triage everything.
ALTER TABLE "customer_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "customer_requests_tenant_select" ON "customer_requests"
  FOR SELECT
  USING ("organization_id" = current_setting('app.current_organization_id', true));

CREATE POLICY "customer_requests_tenant_insert" ON "customer_requests"
  FOR INSERT
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
    AND "requester_user_id" = current_setting('app.current_user_id', true)
    AND "status" = 'submitted'
    AND "assigned_to_user_id" IS NULL
    AND EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "customer_requests"."academy_id"
        AND a."organization_id" = "customer_requests"."organization_id"
    )
  );

CREATE POLICY "customer_requests_tenant_update" ON "customer_requests"
  FOR UPDATE
  USING ("organization_id" = current_setting('app.current_organization_id', true))
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
    -- A tenant can cancel, or answer (back to in progress); never triage.
    AND "status" IN ('submitted', 'received', 'under_review', 'in_progress', 'waiting_for_customer', 'cancelled')
  );

CREATE POLICY "customer_requests_platform_select" ON "customer_requests"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "customer_requests_platform_update" ON "customer_requests"
  FOR UPDATE
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));

-- ---------------------------------------------------------------------------
-- RLS: customer_request_events
-- ---------------------------------------------------------------------------
-- A tenant reads only `customer` rows of its own organization: internal
-- notes and assignment never leave the team, whatever the API does.
ALTER TABLE "customer_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_request_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY "customer_request_events_tenant_select" ON "customer_request_events"
  FOR SELECT
  USING (
    "organization_id" = current_setting('app.current_organization_id', true)
    AND "visibility" = 'customer'
  );

CREATE POLICY "customer_request_events_tenant_insert" ON "customer_request_events"
  FOR INSERT
  WITH CHECK (
    "organization_id" = current_setting('app.current_organization_id', true)
    AND "visibility" = 'customer'
    AND "actor_side" = 'customer'
    AND "actor_user_id" = current_setting('app.current_user_id', true)
    AND "kind" IN ('created', 'status_changed', 'customer_message')
    AND EXISTS (
      SELECT 1 FROM "customer_requests" r
      WHERE r."id" = "customer_request_events"."request_id"
        AND r."organization_id" = "customer_request_events"."organization_id"
    )
  );

CREATE POLICY "customer_request_events_platform_select" ON "customer_request_events"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

CREATE POLICY "customer_request_events_platform_insert" ON "customer_request_events"
  FOR INSERT
  WITH CHECK (
    is_platform_owner(current_setting('app.current_user_id', true))
    AND "actor_side" = 'team'
  );

-- ---------------------------------------------------------------------------
-- RLS: customer_request_routing_rules — Platform Owners only.
-- ---------------------------------------------------------------------------
ALTER TABLE "customer_request_routing_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_request_routing_rules" FORCE ROW LEVEL SECURITY;

CREATE POLICY "customer_request_routing_rules_platform_all" ON "customer_request_routing_rules"
  FOR ALL
  USING (is_platform_owner(current_setting('app.current_user_id', true)))
  WITH CHECK (is_platform_owner(current_setting('app.current_user_id', true)));
