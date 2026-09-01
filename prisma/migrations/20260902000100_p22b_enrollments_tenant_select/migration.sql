-- ============================================================================
-- Corrective follow-up to 20260902000000_p22_entitlement_enforcement_
-- trial_lifecycle. `enrollments` (P6) was designed with exactly three SELECT
-- policies: `enrollments_self_select` (the enrolled student), `_instructor_
-- select` (an instructor of that specific course), and `_platform_select`
-- (Platform Owner) — a genuinely correct, complete set for P6's own scope,
-- where no organization-level "staff can see every enrollment across the
-- org" read ever existed.
--
-- Phase 2 introduces the first such read:
-- `TenantUsageRecomputeService.computeLiveCounts`'s `students` metric, and
-- `EntitlementEnforcementService.assertWithinLimit`'s live `students` check
-- built on the exact same method — both run under a plain
-- `runInTenantContext(organizationId)` (no specific user), the standard
-- context every other usage/entitlement count in this codebase already
-- reads through. Without a matching SELECT policy, that context could not
-- see ANY `enrollments` row at all — RLS silently returned zero rows,
-- regardless of the WHERE clause — making the `students` metric always
-- read `0` and the entitlement check never able to observe its own limit
-- being reached. Caught by this phase's own new e2e coverage (`tenant-
-- subscription.e2e-spec.ts`'s real-enrollment recompute tests,
-- `entitlement-enforcement.e2e-spec.ts`'s student-limit test), never
-- silently shipped.
--
-- Matches `courses_tenant_select`'s (P5) exact shape: `academy_id` is a
-- plain denormalized column on `enrollments` (see that model's own doc
-- comment), not a Prisma relation, so the organization scope is resolved
-- via the same `EXISTS ... academies ...` join every other academy-scoped
-- tenant-select policy in this schema already uses.
-- ============================================================================

CREATE POLICY "enrollments_tenant_select" ON "enrollments"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "enrollments"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
    )
  );
