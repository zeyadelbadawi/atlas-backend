/**
 * Platform-owner permission catalog.
 *
 * The same root-cause class `Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` (P0-2)
 * already found and fixed once for organization memberships
 * (`tenancy/constants/organization-permissions.constants.ts`), found again
 * live during a P19 follow-up manual test: `toCurrentUser` hardcoded
 * `permissions: []` for every user, including the real seeded Platform
 * Owner (`admin@atlas.dev`) — so every `hasPermission('platform.*')`
 * check in the frontend (`AuthorizationService.hasPermission` falls
 * through to `user.permissions.includes(permission)` when no organization
 * context applies) failed closed for every account, platform owner
 * included. Confirmed live: signed in as the real seeded Platform Owner,
 * opened a real pending payment on the Payment Review page, and the
 * Approve/Reject actions were replaced by "You have permission to view
 * this payment, but not to approve or reject it" — the page's own
 * intended "viewer vs reviewer" distinction working exactly as coded,
 * just against a Platform Owner who could never actually hold the
 * reviewer permission because nothing ever granted it.
 *
 * This is the exact catalog of `platform.*` strings the frontend already
 * checks (`grep`-verified against every `hasPermission('platform.*')` call
 * site) — never invented, only collected from what the frontend already
 * expects. Route-level access (which platform pages are reachable at all)
 * remains gated by `requiredRoles: ['platform_owner']` — unaffected,
 * unchanged. This catalog only affects the page-level action gates layered
 * on top of that, matching the organization-permissions precedent's own
 * "route permission vs. action permission" split.
 */
export const PLATFORM_OWNER_PERMISSIONS: readonly string[] = [
  'platform.payment.approve',
  'platform.payment.reject',
  'platform.provisioning.manage',
  'platform.support.manage',
] as const;

/**
 * Baseline permissions every authenticated Atlas user holds, regardless of
 * organization membership or platform-owner status — "being a student" in
 * this codebase is not a role or a membership row (`Enrollment` has no org/
 * academy-membership requirement at all: its RLS policies key only on
 * `student_id = app.current_user_id`, and `courses_public_discovery_select`
 * gates on the course's own `status`/`visibility`, not on the caller — see
 * `Enrollment`'s own schema doc comment). Confirmed live during a real
 * browser acceptance test: `student.course.view`/`student.learning.view`/
 * `student.quiz.view`/`student.assignment.view` (checked by `RouteGuard`
 * for every `/dashboard/learning/*` route) were granted to NO account
 * anywhere in the system — not a plain member, not an Organization Owner,
 * not even the Platform Owner — so literally nobody could browse the
 * course catalog or view a course as a student through the real UI. These
 * are self-service permissions with no elevated capability (they gate
 * reading published/public data and creating rows scoped to the caller's
 * own id), so granting them unconditionally to every signed-in user is the
 * correct floor — the same floor `ORGANIZATION_MEMBER_PERMISSIONS` already
 * establishes for `academy.view`/`academy.website.view` at the
 * organization layer. `forum.thread.create`/`forum.view` are included
 * because a student's own course-scoped discussion access has the exact
 * same "any authenticated user, no membership needed" shape.
 */
export const BASE_USER_PERMISSIONS: readonly string[] = [
  'student.course.view',
  'student.learning.view',
  'student.quiz.view',
  'student.assignment.view',
  'forum.view',
  'forum.thread.create',
] as const;
