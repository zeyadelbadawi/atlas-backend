/**
 * The learner dashboard's read contracts (master plan Phase 2 §D.8/§E.1).
 *
 * EVERY ONE OF THESE IS SCOPED TO THE HOST ACADEMY. A person can be a
 * learner at several academies with the same account (AD-4), and each
 * academy's site must show only its own courses, results and deadlines —
 * showing a competitor academy's course list on this academy's branded
 * dashboard would be a tenancy leak the learner would notice immediately.
 * The scope comes from the request HOST, never from a query parameter.
 *
 * COUNTS ARE SERVER-COMPUTED (§E.1's "with server counts"). The previous
 * My Learning page counted a page of results and called it the total,
 * which was wrong the moment a learner had more courses than fitted on
 * one page.
 */

export interface ContinueLearningItem {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly courseThumbnailUrl: string | null;
  readonly percentage: number;
  readonly completedLessons: number;
  readonly totalLessons: number;
  /** Lessons, quizzes and assignments together — what `percentage` is computed from. */
  readonly completedItems: number;
  readonly totalItems: number;
  /** Where "Continue" goes. Null when the course has nothing left to resume. */
  readonly nextItemId: string | null;
  readonly nextItemTitle: string | null;
  readonly lastActivityAt: string | null;
}

export interface LearnerCourseCounts {
  readonly all: number;
  readonly inProgress: number;
  readonly completed: number;
}

export interface UpcomingDeadline {
  readonly id: string;
  readonly type: 'assignment' | 'live_session';
  readonly title: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly dueAt: string;
  readonly overdue: boolean;
}

export interface RecentResult {
  readonly id: string;
  readonly type: 'quiz' | 'assignment';
  readonly title: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly status: string;
  readonly score: number | null;
  readonly at: string;
}

export interface LearnerAnnouncement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: string | null;
  readonly courseId: string | null;
}

export interface LearnerOverviewResponse {
  readonly academyId: string;
  readonly continueLearning: readonly ContinueLearningItem[];
  readonly courseCounts: LearnerCourseCounts;
  readonly upcomingDeadlines: readonly UpcomingDeadline[];
  readonly recentResults: readonly RecentResult[];
  readonly announcements: readonly LearnerAnnouncement[];
  /**
   * Certificates are Phase 3. Reported as an explicit, honest zero with a
   * flag rather than omitted, so the dashboard can render "coming soon"
   * instead of an empty list that looks like a learner earned none.
   */
  /** P64 Phase 3 — real once the `certificates` flag admits the academy. */
  readonly certificates: { readonly available: boolean; readonly count: number };
}

export interface LearnerAssessmentItem {
  readonly id: string;
  readonly type: 'quiz' | 'assignment';
  readonly title: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly state: string;
  readonly dueAt: string | null;
  readonly score: number | null;
  readonly submittedAt: string | null;
}

export interface LearnerDeviceResponse {
  readonly id: string;
  readonly label: string;
  readonly lastSeenAt: string;
  readonly createdAt: string;
  /** True for the browser making THIS request, so the UI can say "this device" and warn before removing it. */
  readonly current: boolean;
}

export interface LearnerSessionResponse {
  readonly sessionId: string;
  readonly deviceLabel: string | null;
  readonly locationCountry: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface LearnerDevicesResponse {
  readonly devices: readonly LearnerDeviceResponse[];
  readonly sessions: readonly LearnerSessionResponse[];
  readonly maxDevices: number;
  readonly maxConcurrentSessions: number;
  /** Which policy row decided — `academy` when the Client Owner set one, otherwise the platform default. */
  readonly policySource: 'academy' | 'plan' | 'platform' | 'default';
}
