/**
 * `StudentAnalytics` response contract — Phase 9's Client-Owner-facing
 * student progress rollup (roadmap finding CO11).
 *
 * ============================ DEFINITIONS ============================
 * The roadmap asks for "cohort trends, at-risk students, completion
 * funnels" and forbids fabricating any of them. Every figure below is
 * therefore computed from rows that already exist in production, and the
 * exact rule is stated here so the number on screen is always traceable
 * to a definition rather than to a guess.
 *
 * COMPLETION FUNNEL — three counts over the scope's `enrollments`, each a
 * strict superset of the next:
 *   enrolled  = every enrollment with status `enrolled` or `completed`
 *               (i.e. a real seat; `available`/`pending`/`unavailable`
 *               are not enrolments a student actually holds).
 *   started   = of those, the ones whose materialized `CourseProgress`
 *               reports `completedLessons > 0`. "Started" deliberately
 *               means a completed lesson, not merely opening the course:
 *               opening is not recorded anywhere, so any other definition
 *               would be invented.
 *   completed = of those, `CourseProgress.completionState = 'completed'`.
 * A course with no `CourseProgress` row yet counts as enrolled-only. No
 * conversion rate is stored here — the UI derives percentages from these
 * three real counts.
 *
 * COHORT TRENDS — a real monthly time series over `Enrollment.enrolledAt`
 * (new enrolments) and `Enrollment.completedAt` (completions), for the
 * requested window. Months with no activity are returned with explicit
 * zeros so the series is continuous; that is a real zero (nothing
 * happened that month), not a placeholder. Enrolments whose `enrolledAt`
 * is null are excluded rather than being attributed to an invented date.
 *
 * AT-RISK STUDENTS — a deterministic, explainable rule, never a score or
 * a heuristic. An enrolment is at risk when it is genuinely in progress
 * (status `enrolled`, `completionState` not `completed`) AND at least one
 * of these is true:
 *   'no_progress'  — `completedLessons = 0` and the enrolment is older
 *                    than `AT_RISK_INACTIVITY_DAYS`. The student took a
 *                    seat and has finished nothing since.
 *   'stalled'      — some progress exists, but `CourseProgress.updatedAt`
 *                    (which only moves when a lesson is completed) is
 *                    older than `AT_RISK_INACTIVITY_DAYS`.
 *   'failing_quiz' — the student has at least one scored attempt on a
 *                    quiz in this course and has not passed any attempt
 *                    on that quiz.
 * Every at-risk row carries the reasons that fired, so the UI can always
 * explain WHY a student was flagged. A student is never flagged without
 * one of these concrete facts.
 *
 * WHAT IS DELIBERATELY NOT MEASURED. There is no "engagement score", no
 * predicted completion date, no time-spent metric and no login-recency
 * metric — Atlas records no session/lesson-view/time-on-page events, so
 * any of those would be fabricated. If such events are added later, this
 * contract can grow; it does not guess in their absence.
 */

/** Days of inactivity before an in-progress enrolment is considered stalled. A product threshold, stated once here so the UI can name it in its own copy rather than hardcoding a number of its own. */
export const AT_RISK_INACTIVITY_DAYS = 14;

export type AtRiskReason = 'no_progress' | 'stalled' | 'failing_quiz';

export interface CompletionFunnelResponse {
  readonly enrolled: number;
  readonly started: number;
  readonly completed: number;
}

export interface CohortTrendPointResponse {
  /** `YYYY-MM`, the month this point covers. */
  readonly month: string;
  readonly newEnrollments: number;
  readonly completions: number;
}

export interface AtRiskStudentResponse {
  readonly studentId: string;
  readonly studentName: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly academyId: string;
  readonly completedLessons: number;
  readonly totalLessons: number;
  /** Last time this enrolment's progress actually changed; `null` when no progress row exists yet. */
  readonly lastProgressAt: string | null;
  readonly reasons: readonly AtRiskReason[];
}

export interface StudentAnalyticsResponse {
  readonly scope: {
    readonly type: 'organization' | 'academy';
    readonly organizationId: string;
    readonly academyId?: string;
  };
  /** Inclusive ISO dates bounding the cohort series actually returned. */
  readonly window: { readonly from: string; readonly to: string };
  readonly funnel: CompletionFunnelResponse;
  readonly cohortTrends: readonly CohortTrendPointResponse[];
  readonly atRiskStudents: readonly AtRiskStudentResponse[];
  /** Total at-risk enrolments matching the rule, which may exceed the number of rows returned in `atRiskStudents`. */
  readonly atRiskTotal: number;
  readonly inactivityThresholdDays: number;
}
