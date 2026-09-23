/**
 * Owner reports response contracts (P64 Phase 4, master plan §D.6/§E.5):
 * the two academy-scoped aggregates a Client Owner / manager reads —
 * integrity summaries (quiz attempt events) and sharing signals (protected
 * content access refusals). Quota usage is NOT re-implemented here: the
 * existing `GET organizations/:id/usage` (`TenantUsageResponse`) already
 * answers it and the reports page reads that directly.
 *
 * Every number is derived from ONE bounded read aggregated in memory (the
 * `StudentAnalyticsService` precedent), so the totals, the breakdowns and
 * the top-N lists can never disagree with each other. `truncated` says the
 * read hit its row ceiling, so the caller knows the numbers are a floor.
 *
 * PII discipline: rows carry ids plus the same display name the roster
 * already shows — never emails, device fingerprints, or IPs.
 */

export interface ReportWindowResponse {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

export interface IntegrityReportCourseRow {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly events: number;
  readonly attemptsWithEvents: number;
}

export interface AcademyIntegrityReportResponse {
  readonly academyId: string;
  readonly window: ReportWindowResponse;
  /** Every recorded attempt event in the window. */
  readonly totalEvents: number;
  /** Events the engine counted against the attempt's integrity budget. */
  readonly countedEvents: number;
  /** Distinct attempts that recorded at least one event. */
  readonly attemptsWithEvents: number;
  /** Per `QuizAttemptEventType`. */
  readonly byType: Readonly<Record<string, number>>;
  readonly topCourses: readonly IntegrityReportCourseRow[];
  readonly truncated: boolean;
}

export interface SharingReportCourseRow {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly refusals: number;
}

export interface SharingReportUserRow {
  readonly userId: string;
  readonly userName?: string;
  readonly refusals: number;
}

export interface AcademySharingReportResponse {
  readonly academyId: string;
  readonly window: ReportWindowResponse;
  readonly granted: number;
  readonly refused: number;
  /** Per refusal `reason` (e.g. deviceLimit, sessionConflict); unknown → `other`. */
  readonly refusedByReason: Readonly<Record<string, number>>;
  readonly distinctUsersRefused: number;
  readonly distinctDevicesRefused: number;
  readonly topCourses: readonly SharingReportCourseRow[];
  readonly topUsers: readonly SharingReportUserRow[];
  readonly truncated: boolean;
}
