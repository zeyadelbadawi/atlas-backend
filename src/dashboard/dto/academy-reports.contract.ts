/**
 * Owner reports response contracts (P64 Phase 4, master plan §D.6/§E.5):
 * the two academy-scoped aggregates a Client Owner / manager reads —
 * integrity summaries (quiz attempt events) and sharing signals (protected
 * content access refusals). Quota usage is NOT re-implemented here: the
 * existing `GET organizations/:id/usage` (`TenantUsageResponse`) already
 * answers it and the reports page reads that directly.
 *
 * B0-ANL-03 — the headline numbers (totals, breakdowns, distinct counts)
 * are exact grouped counts over the whole window. The top-N lists are
 * ranked from a bounded, newest-first read; `truncated` says that read hit
 * its row ceiling, so the lists rank the window's most recent rows only.
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
