/**
 * `AcademyStats` response contract — matches `academy.types.ts` exactly.
 *
 * `totalMembers`/`activeStaff`/`activeInstructors` are real, computed from
 * `academy_members` rows within the active tenant context.
 *
 * `publishedCourses` counts this academy's courses in `published` status
 * (the same rule as the organization dashboard's published-course count).
 */
export interface AcademyStatsResponse {
  readonly totalMembers: number;
  readonly activeStaff: number;
  readonly activeInstructors: number;
  readonly publishedCourses: number;
}
