/**
 * `AcademyStats` response contract — matches `academy.types.ts` exactly.
 *
 * `totalMembers`/`activeStaff`/`activeInstructors` are real, computed from
 * `academy_members` rows within the active tenant context.
 *
 * `publishedCourses` is honestly `0`, not a placeholder standing in for a
 * hidden error: no `courses` table exists yet (Course Management is
 * explicitly out of P3's scope — see this phase's final report). This
 * mirrors the resolution already reached for the Notifications frontend
 * finding this session (real absence of backend scope, reported as `0`/
 * empty rather than invented data) — the value will become real the day
 * Course Management ships, not before.
 */
export interface AcademyStatsResponse {
  readonly totalMembers: number;
  readonly activeStaff: number;
  readonly activeInstructors: number;
  readonly publishedCourses: number;
}
