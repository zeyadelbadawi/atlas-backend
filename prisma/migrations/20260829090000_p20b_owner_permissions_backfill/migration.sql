-- ============================================================================
-- P20b: backfill existing organization_memberships.permissions after
-- `ORGANIZATION_OWNER_PERMISSIONS` was corrected to be a superset of
-- `ORGANIZATION_MANAGER_PERMISSIONS`.
--
-- `organization_memberships.permissions` is a plain snapshot column,
-- written once at INSERT time by whichever service created the row
-- (`OrganizationsService.create` for an owner, `AcademiesService.addManager`
-- for a manager) — it is never recomputed from `permissionsForRole(role)`
-- on read (`UserOrganizationsService.getMembershipsForUser` reads the
-- stored array directly). So editing the TypeScript catalog constant only
-- changes what gets written into a membership row created AFTER the code
-- change; it does nothing for rows that already exist — confirmed live:
-- signing in as the actual seeded Organization Owner still showed the OLD,
-- narrower permission set until this backfill ran.
--
-- This is a one-time data correction, not a schema change: every existing
-- `role = 'owner'` row is rewritten to the corrected, superset permission
-- list; every existing `role = 'manager'` row is rewritten to the (in this
-- case unchanged, but included for completeness/consistency) manager list.
-- Any future permission-catalog change follows this exact same pattern —
-- a migration that re-snapshots existing rows — since this codebase's
-- deliberate design (documented in `organization-permissions.constants.ts`)
-- is a flat snapshot column, not a live-computed one.
-- ============================================================================

UPDATE "organization_memberships"
SET "permissions" = ARRAY[
  'academy.view',
  'academy.members.view',
  'academy.configure',
  'academy.branding.update',
  'academy.website.view',
  'academy.website.manage',
  'academy.website.publish',
  'course.view',
  'course.create',
  'course.manage',
  'course.update',
  'course.configure',
  'instructor.dashboard.view',
  'instructor.course.view',
  'instructor.student.view',
  'instructor.assessment.view',
  'instructor.assignment.grade',
  'instructor.submission.view',
  'announcement.view',
  'announcement.manage',
  'forum.view',
  'forum.thread.create',
  'forum.moderate',
  'blog.view',
  'blog.create',
  'tenant.dashboard.view',
  'tenant.subscription.view',
  'tenant.usage.view',
  'tenant.addon.view',
  'tenant.billing.view',
  'tenant.payment.view',
  'tenant.payment.create',
  'academy.provisioning.view',
  'academy.provisioning.create'
]::text[]
WHERE "role" = 'owner';

UPDATE "organization_memberships"
SET "permissions" = ARRAY[
  'academy.view',
  'academy.members.view',
  'academy.configure',
  'academy.branding.update',
  'academy.website.view',
  'academy.website.manage',
  'academy.website.publish',
  'course.view',
  'course.create',
  'course.manage',
  'course.update',
  'course.configure',
  'instructor.dashboard.view',
  'instructor.course.view',
  'instructor.student.view',
  'instructor.assessment.view',
  'instructor.assignment.grade',
  'instructor.submission.view',
  'announcement.view',
  'announcement.manage',
  'forum.view',
  'forum.thread.create',
  'forum.moderate',
  'blog.view',
  'blog.create'
]::text[]
WHERE "role" = 'manager';
