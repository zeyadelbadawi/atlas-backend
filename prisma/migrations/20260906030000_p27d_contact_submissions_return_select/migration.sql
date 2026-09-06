-- ============================================================================
-- P27d — fixes a real bug found while testing the new public Contact
-- submission endpoint (`POST public/websites/:academyId/contact`).
--
-- Root cause (confirmed live, isolated down to a minimal raw-SQL repro):
-- Postgres requires a newly-`INSERT`ed row to ALSO satisfy an applicable
-- SELECT policy when the statement carries a `RETURNING` clause — which
-- Prisma's `.create()` always does. `contact_submissions` had exactly one
-- SELECT policy, `contact_submissions_manage_select`
-- (`is_academy_moderator`, requires a real staff `app.current_user_id`) —
-- meaningless for this public, no-user-context insert, so the `RETURNING`
-- half of the statement had no policy to satisfy at all and the WHOLE
-- INSERT was rejected with "new row violates row-level security policy",
-- even though the `contact_submissions_public_insert` WITH CHECK itself
-- (independently re-verified live via a direct SQL probe against the same
-- transaction) evaluated true.
--
-- Fix: an additive SELECT policy scoped to the SAME organization-tenant-
-- context check `contact_submissions_public_insert`'s WITH CHECK already
-- uses — mirrors `academies_tenant_select` (P3)'s own precedent exactly:
-- "any caller who has legitimately opened a real organization's tenant
-- context (via a real, server-resolved academyId — never a client-
-- supplied organization id) may read that organization's own
-- `contact_submissions` rows." This is additive to (never replacing)
-- `contact_submissions_manage_select`; the two currently-real callers of
-- `ContactSubmissionsRepository` remain exactly as gated as before this
-- migration (the public insert's own `RETURNING`, and
-- `AcademiesService.getContactSubmissions`/`updateContactSubmissionStatus`,
-- which still independently re-check `assertCanManage` at the application
-- layer before ever reaching this repository).
-- ============================================================================

CREATE POLICY "contact_submissions_tenant_select" ON "contact_submissions"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "contact_submissions"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
