/**
 * Organization-membership permission catalog (Phase P19).
 *
 * `Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` (P0-2) found that
 * `organization_memberships.permissions` was a real, RLS-visible column
 * that no code anywhere ever populated — every `requiredPermissions`
 * check in the frontend's `RouteGuard`/navigation config
 * (`organization.permissions.includes(permission)`) therefore failed
 * closed for every account, including a fully-privileged, actively-paying
 * Organization Owner. This is the exact catalog of strings the frontend
 * already checks (`grep`-verified against `atlas-front/src/app/
 * navigation/navigation.config.ts` and `AppRouter.tsx`'s own
 * `requiredPermissions` usages) for the tenant/organization-management
 * surface this phase's journey touches — never invented, only collected
 * from what the frontend already expects.
 *
 * Scope note (updated by the Organization Manager phase — see
 * `ORGANIZATION_MANAGER_PERMISSIONS` below): `course.*`/`instructor.*`/
 * `student.*`/`announcement.*`/`blog.*`/`forum.*` permission strings also
 * appear in the frontend. Historically these gated Academy-membership-
 * scoped features (`academy_members.role`) with no corresponding
 * organization-level permission ever granting them — the P19 report
 * flagged this as a known remaining limitation, and it was ONLY half
 * closed when this file first added `ORGANIZATION_MANAGER_PERMISSIONS`:
 * confirmed live (real browser login as the actual seeded Organization
 * Owner) that `ORGANIZATION_OWNER_PERMISSIONS` itself never carried any
 * of these strings either — meaning the real account owner of an
 * organization could not reach Course Management or the Instructor
 * dashboard at all, while a Manager they granted access to could. An
 * owner missing capability a manager holds is backwards for a role
 * `permissionsForRole` treats as strictly more privileged everywhere
 * else, so `ORGANIZATION_OWNER_PERMISSIONS` is now defined as
 * `ORGANIZATION_MANAGER_PERMISSIONS` plus the owner-exclusive
 * `tenant.*`/`academy.provisioning.*` strings, guaranteeing the owner set
 * is always a superset of the manager set as both evolve — never two
 * lists that can silently drift apart again.
 */

/**
 * An Organization/Academy Manager's permission set — everything needed to
 * operate the academy's day-to-day platform surface (courses, curriculum,
 * instructors, students, website content, community moderation)
 * day-to-day, but deliberately EXCLUDING every `tenant.*` (billing,
 * subscription, usage, add-ons, payment) and `academy.provisioning.*`
 * string: those stay Organization-Owner-only, matching the product
 * decision that a Manager operates the academy but never touches the
 * SaaS account's money or provisioning of new academies. Granted whenever
 * `AcademiesService.addManager` creates (or reuses) this user's
 * `organization_memberships` row — see that method's doc comment.
 */
export const ORGANIZATION_MANAGER_PERMISSIONS: readonly string[] = [
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
] as const;

/**
 * An Instructor's permission set — narrower than a Manager's: read/
 * participate access to the academy's teaching surface (their own
 * instructor dashboard, course/student/assessment views, grading,
 * submissions, community read/participate), but deliberately EXCLUDING
 * every content-authoring string a Manager holds (`course.create`,
 * `course.manage`, `course.update`, `course.configure`,
 * `academy.configure`, `academy.branding.update`, `academy.members.view`,
 * `academy.website.manage`, `academy.website.publish`,
 * `announcement.manage`, `forum.moderate`, `blog.create`) and every
 * `tenant.*`/`academy.provisioning.*` string an Owner holds — matching the
 * product requirement that an Instructor never accidentally receives
 * Client/Admin/Manager-only capability. Granted whenever
 * `AcademiesService.addInstructor` creates (or reuses) this user's
 * `organization_memberships` row.
 */
export const ORGANIZATION_INSTRUCTOR_PERMISSIONS: readonly string[] = [
  'academy.view',
  'academy.website.view',
  'instructor.dashboard.view',
  'instructor.course.view',
  'instructor.student.view',
  'instructor.assessment.view',
  'instructor.assignment.grade',
  'instructor.submission.view',
  'announcement.view',
  'forum.view',
  'forum.thread.create',
  'blog.view',
] as const;

/**
 * Every organization-scoped permission string a real Organization Owner
 * needs — everything a Manager can do (see `ORGANIZATION_MANAGER_PERMISSIONS`
 * above), PLUS the owner-exclusive billing/subscription/usage/add-on/
 * payment and academy-provisioning strings a Manager deliberately never
 * gets. Built as a spread rather than a separately maintained list so the
 * owner set can never regress to missing something the manager set
 * carries (the exact bug this comment's scope note documents finding).
 */
export const ORGANIZATION_OWNER_PERMISSIONS: readonly string[] = [
  ...ORGANIZATION_MANAGER_PERMISSIONS,
  'tenant.dashboard.view',
  'tenant.subscription.view',
  'tenant.usage.view',
  'tenant.addon.view',
  'tenant.billing.view',
  'tenant.payment.view',
  'tenant.payment.create',
  'academy.provisioning.view',
  'academy.provisioning.create',
] as const;

/**
 * A plain (non-owner, non-manager) member's default permission set —
 * deliberately narrow (read-only academy visibility only). Still
 * unreachable via any endpoint today (`addManager` always grants
 * `'manager'`, never plain `'member'`) — kept as the safe fallback
 * `permissionsForRole` reaches for on any role string it does not
 * recognize, rather than a silent `permissions: []`.
 */
export const ORGANIZATION_MEMBER_PERMISSIONS: readonly string[] = [
  'academy.view',
  'academy.website.view',
];

export function permissionsForRole(role: string): readonly string[] {
  switch (role) {
    case 'owner':
      return ORGANIZATION_OWNER_PERMISSIONS;
    case 'manager':
      return ORGANIZATION_MANAGER_PERMISSIONS;
    case 'instructor':
      return ORGANIZATION_INSTRUCTOR_PERMISSIONS;
    default:
      return ORGANIZATION_MEMBER_PERMISSIONS;
  }
}
