-- ============================================================================
-- P24e — backfill `quiz.manage`/`assignment.manage` onto existing
-- `organization_memberships` rows (master plan §22/§24, Phase 4 follow-up).
--
-- Discovered during Phase 4 browser acceptance testing, not designed up
-- front: `organizations_permissions.constants.ts` intentionally stores each
-- role's permission set as a snapshot ON THE MEMBERSHIP ROW at grant time
-- (`organizations.service.ts`'s owner grant, `academies.service.ts`'s
-- manager/instructor grants) rather than recomputing it from
-- `permissionsForRole(role)` on every read — a deliberate P2 design (no
-- Role/Permission catalog table, per the `OrganizationMembership` model's
-- own doc comment). The P24 migration added `quiz.manage`/
-- `assignment.manage` to `ORGANIZATION_MANAGER_PERMISSIONS`/
-- `ORGANIZATION_INSTRUCTOR_PERMISSIONS` (and therefore, transitively, to
-- `ORGANIZATION_OWNER_PERMISSIONS`), but that constant change only takes
-- effect for a membership row written AFTER the change — every
-- pre-existing Owner/Manager/Instructor membership (all seed data, and any
-- real membership granted before this deploy) keeps its stale snapshot and
-- is missing both new permission strings. Left unfixed, the frontend's
-- `<RouteGuard requiredPermissions={['quiz.manage']}>` would silently lock
-- every pre-existing academy owner/manager/instructor out of the new Quiz/
-- Assignment authoring pages, even though the real server-side
-- authorization (`assertCanAuthorCourseContent`/RLS) already permits the
-- operation — exactly the kind of "Phase 4 doesn't actually work end to
-- end in the browser for a real user" gap the acceptance-testing pass
-- exists to catch.
--
-- Purely additive: appends the two permission strings only to rows that
-- don't already have them, for exactly the three roles P24 granted them
-- to. Every other row (member-role memberships, and any role's other
-- permission strings) is untouched.
-- ============================================================================

-- De-duplicates via `array_agg(DISTINCT ...)` (order is irrelevant — every
-- caller checks membership with `.includes()`/`@>`, never index) so a row
-- already carrying exactly one of the two strings (never expected in
-- practice, since P24 added both together, but not guaranteed by the
-- `WHERE` below) still ends up with a clean, non-duplicated set.
UPDATE "organization_memberships" m
SET "permissions" = (
  SELECT array_agg(DISTINCT perm)
  FROM unnest(m."permissions" || ARRAY['quiz.manage', 'assignment.manage']) AS perm
)
WHERE m."role" IN ('owner', 'manager', 'instructor')
  AND NOT (m."permissions" @> ARRAY['quiz.manage', 'assignment.manage']);
