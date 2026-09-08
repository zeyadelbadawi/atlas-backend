-- Phase 8 — Support, Audit & Dashboards (roadmap: ATLAS_PRODUCTION_ROADMAP.md).
--
-- Purely additive: three nullable columns, their indexes/FKs, and four new
-- RLS policies. No existing column, table, index, or policy is dropped or
-- altered — every existing `audit_log_entries`/`support_cases`/
-- `provisioning_requests` row keeps working unchanged (new columns default
-- to NULL).
--
-- 1. `audit_log_entries.academy_id`/`.role` — closes the gap this phase's
--    audit found: the table had no way to scope an entry to one Academy
--    (needed for a Manager's "recent activity" widget, never the whole
--    Organization) or to record the acting user's role at the time of the
--    action. Mirrors `organization_id`'s existing nullable, `ON DELETE SET
--    NULL` shape exactly — an audit row must never be deleted just because
--    the Academy it referenced later is.
--
-- 2. `support_cases.academy_id` — lets a ticket be scoped to one Academy
--    (an Academy Manager's own ticket, or the provisioning auto-ticket,
--    which always concerns one specific Academy's provisioning request).
--    `NULL` stays valid for an Organization-level ticket with no single
--    Academy (unchanged from before this migration).
--
-- 3. `provisioning_requests.auto_support_case_id` — the dedup marker
--    `ProvisioningOrchestratorService` checks before auto-opening a
--    support case after repeated failures, so a request stuck retrying
--    the same failed step never opens a second ticket for the same
--    failure episode. Deliberately NOT a new failure counter — the
--    orchestrator reuses the existing `attempt_count`/`status` state.
--
-- 4. RLS — `support_cases`/`support_case_messages` previously had no
--    INSERT path and no non-Platform-Owner SELECT path at all (see the
--    P15 migration's own doc comment: "no create-case endpoint in this
--    phase"). This phase adds the real tenant-facing create/track
--    endpoint, so it adds the matching RLS: a caller may create a case
--    only as themselves, within their own already-verified organization
--    (and, if scoped to one, an academy they are actually a member of),
--    and may only ever read a case (or its messages) that THEY
--    personally requested — never another member of the same
--    organization's tickets, and never another organization's. This is
--    deliberately narrower than `is_org_member`-style organization-wide
--    visibility: a support ticket is personal correspondence with the
--    Platform, not organization-shared data, matching how the existing
--    Platform-Owner side already treats it as a 1:1 conversation.
-- ---------------------------------------------------------------------------

ALTER TABLE "audit_log_entries" ADD COLUMN "academy_id" TEXT;
ALTER TABLE "audit_log_entries" ADD COLUMN "role" TEXT;

ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "audit_log_entries_academy_id_occurred_at_idx"
  ON "audit_log_entries"("academy_id", "occurred_at" DESC);

ALTER TABLE "support_cases" ADD COLUMN "academy_id" TEXT;

ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_academy_id_fkey"
  FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_cases_academy_id_idx" ON "support_cases"("academy_id");

ALTER TABLE "provisioning_requests" ADD COLUMN "auto_support_case_id" TEXT;

ALTER TABLE "provisioning_requests" ADD CONSTRAINT "provisioning_requests_auto_support_case_id_fkey"
  FOREIGN KEY ("auto_support_case_id") REFERENCES "support_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS additions
-- ---------------------------------------------------------------------------

-- A caller may only ever create a case as themselves (`requester_user_id`
-- matches the real, session-established `app.current_user_id` — never a
-- client-supplied value the application layer merely echoes into the
-- INSERT), within the organization membership `OrganizationMembershipGuard`/
-- `AcademyScopeGuard` already independently verified (`organization_id`
-- matches `app.current_organization_id`), and — only if the ticket names
-- one — an Academy they are a real member of. Mirrors
-- `provisioning_requests_tenant_insert`'s exact organization-scoping idiom.
CREATE POLICY "support_cases_requester_insert" ON "support_cases"
  FOR INSERT
  WITH CHECK (
    "requester_user_id"::text = current_setting('app.current_user_id', true)
    AND "organization_id"::text = current_setting('app.current_organization_id', true)
    AND (
      "academy_id" IS NULL
      OR is_academy_member("academy_id"::text, current_setting('app.current_user_id', true))
    )
  );

-- A caller may read (list/track) only a case THEY personally requested —
-- runs under `runInUserContext` alone (no tenant context required), the
-- same "user-scoped, not tenant-scoped" shape `CourseOrder`'s own RLS
-- already established for personal-not-organization-shared data.
CREATE POLICY "support_cases_requester_select" ON "support_cases"
  FOR SELECT
  USING ("requester_user_id"::text = current_setting('app.current_user_id', true));

-- The message thread of a case the caller may already read under the
-- policy above — never a case belonging to a different requester, even
-- within the same organization.
CREATE POLICY "support_case_messages_requester_select" ON "support_case_messages"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "support_cases" sc
      WHERE sc."id" = "support_case_messages"."case_id"
        AND sc."requester_user_id"::text = current_setting('app.current_user_id', true)
    )
  );
