/**
 * Zoom Operations Center response contracts — Platform Owner only.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY IT MUST STAY ABSENT: no
 * `encryptedCredentials`, no access or refresh token, no token
 * fingerprint, no granted-scope secret, no client secret, no webhook
 * secret, no raw provider payload, no signature. An operations console
 * needs to know THAT a connection is healthy, never what it is made of.
 *
 * `externalAccountId` is the one provider identifier that does travel,
 * and it is masked (see `maskAccountId`). It is the id Atlas attributes
 * webhooks by, so an operator genuinely needs to recognise it — but a
 * full account id in a screenshot or a support ticket is more than that
 * requires.
 */

/** Connection lifecycle, mirroring `LiveProviderConnectionStatus` exactly. */
export type ZoomConnectionStatus =
  'not_connected' | 'connected' | 'expired' | 'revoked' | 'error' | 'reconnect_required';

/**
 * Masks a provider account id for display.
 *
 * Keeps enough to recognise a specific account across pages without
 * reproducing it in full. Short ids are masked entirely rather than
 * partially revealed.
 */
export function maskAccountId(accountId: string | null | undefined): string | undefined {
  if (!accountId) return undefined;
  if (accountId.length <= 6) return '•'.repeat(accountId.length);
  return `${accountId.slice(0, 3)}${'•'.repeat(Math.min(accountId.length - 6, 8))}${accountId.slice(-3)}`;
}

export interface ZoomConnectionRow {
  readonly academyId: string;
  readonly academyName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  /** Whether the Live Sessions add-on is installed/enabled for the org. */
  readonly addOnInstalled: boolean;
  readonly status: ZoomConnectionStatus;
  /** Masked — never the full provider account id. */
  readonly maskedAccountId?: string;
  readonly connectedAt?: string;
  readonly lastCheckedAt?: string;
  /** Provider-agnostic summary only, e.g. "app_deauthorized". Never a payload. */
  readonly lastCheckReason?: string;
  readonly lastEventAt?: string;
  /** True when the connection needs operator attention. */
  readonly hasIssue: boolean;
}

export interface ZoomLiveSessionRow {
  readonly id: string;
  readonly title: string;
  readonly academyId: string;
  readonly academyName: string;
  readonly organizationName: string;
  readonly courseTitle?: string;
  readonly hostName?: string;
  readonly status: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  /** False when Atlas never obtained a provider meeting for this session. */
  readonly provisioned: boolean;
  readonly recordingEnabled: boolean;
  readonly recordingStatus?: string;
  readonly attendanceReconciledAt?: string;
  readonly reconciliationAttempts: number;
  /** Non-sensitive failure summary already stored on the session. */
  readonly failureReason?: string;
  /** Derived: the session may not run because its academy cannot reach Zoom. */
  readonly atRisk: boolean;
  readonly riskReason?: string;
}

export interface ZoomOverviewResponse {
  readonly connections: {
    readonly connected: number;
    readonly reconnectRequired: number;
    readonly revoked: number;
    readonly expired: number;
    readonly error: number;
    readonly notConnected: number;
    readonly notInstalled: number;
  };
  readonly sessions: {
    readonly live: number;
    readonly upcoming: number;
    readonly ended: number;
    readonly cancelled: number;
    readonly failed: number;
    readonly unprovisioned: number;
  };
  readonly events: {
    readonly received: number;
    readonly processed: number;
    readonly unmatched: number;
    readonly failed: number;
  };
  readonly needsAttention: readonly ZoomAttentionItem[];
  readonly upcomingAtRisk: readonly ZoomLiveSessionRow[];
  readonly recentActivity: readonly ZoomActivityRow[];
}

export type ZoomAttentionSeverity = 'critical' | 'warning' | 'info';

export interface ZoomAttentionItem {
  readonly kind: string;
  readonly severity: ZoomAttentionSeverity;
  readonly count: number;
}

export interface ZoomActivityRow {
  readonly id: string;
  readonly action: string;
  readonly academyId?: string;
  readonly organizationId?: string;
  readonly actorName?: string;
  readonly occurredAt: string;
}

/* ---- Part 2: Attendance, Recordings, Events, Health, Activity, Academy detail ---- */

/**
 * A session viewed through the reconciliation lens.
 *
 * Reconciliation state is DERIVED from stored fields, not a new column:
 * `attendanceReconciledAt` set = reconciled; unset but ended with attempts
 * = pending/failing; unset and not ended = not yet due. Nothing here
 * invents a status the domain does not record.
 */
export interface ZoomAttendanceRow {
  readonly sessionId: string;
  readonly title: string;
  readonly academyName: string;
  readonly organizationName: string;
  readonly courseTitle?: string;
  readonly status: string;
  readonly scheduledStartAt: string;
  readonly endedAt?: string;
  readonly reconciledAt?: string;
  readonly reconciliationAttempts: number;
  readonly participantCount: number;
  readonly reconciliationState: 'reconciled' | 'pending' | 'failing' | 'not_due';
}

export interface ZoomRecordingRow {
  readonly recordingId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly academyName: string;
  readonly organizationName: string;
  readonly status: string;
  readonly fileCount: number;
  /** Whether this recording has consumed a quota unit (one per session). */
  readonly quotaConsumed: boolean;
  readonly failureReason?: string;
  readonly createdAt: string;
  readonly availableAt?: string;
}

export interface ZoomEventRow {
  readonly id: string;
  readonly eventType: string;
  readonly status: string;
  readonly academyName?: string;
  readonly sessionTitle?: string;
  readonly failureReason?: string;
  readonly receivedAt: string;
  readonly processedAt?: string;
}

export interface ZoomEventHealth {
  readonly received: number;
  readonly processed: number;
  readonly unmatched: number;
  readonly failed: number;
  readonly byType: readonly { readonly eventType: string; readonly count: number }[];
}

export interface ZoomHealthIssueGroup {
  readonly kind: string;
  readonly severity: ZoomAttentionSeverity;
  readonly count: number;
  /** A few representative affected academies, for triage — never the full list. */
  readonly samples: readonly {
    readonly academyId: string;
    readonly academyName: string;
  }[];
}

export interface ZoomHealthResponse {
  readonly groups: readonly ZoomHealthIssueGroup[];
}

export interface ZoomAcademyDetail {
  readonly academyId: string;
  readonly academyName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly addOnInstalled: boolean;
  readonly connection: {
    readonly status: ZoomConnectionStatus;
    readonly maskedAccountId?: string;
    readonly connectedAt?: string;
    readonly lastCheckedAt?: string;
    readonly lastCheckReason?: string;
  };
  readonly sessions: {
    readonly upcoming: number;
    readonly live: number;
    readonly ended: number;
    readonly failed: number;
    readonly atRisk: number;
  };
  readonly attendance: {
    readonly reconciled: number;
    readonly pending: number;
  };
  readonly recordings: {
    readonly available: number;
    readonly processing: number;
    readonly failed: number;
    /** Entitlement-backed quota from RecordingQuotaService — real, not counted from files. */
    readonly quotaUsed: number;
    readonly quotaLimit: number | 'unlimited';
    readonly quotaRemaining: number | null;
  };
  readonly upcomingAtRisk: readonly ZoomLiveSessionRow[];
  readonly recentActivity: readonly ZoomActivityRow[];
}
