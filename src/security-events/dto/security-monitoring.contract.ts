/** W3 — wire shapes of the OTP & Security Monitoring API. No email, IP, code or hash in full. */
import type { SecurityEventType } from '@prisma/client';

export interface SecurityMonitoringTotals {
  readonly otpSent: number;
  readonly otpResent: number;
  readonly otpVerified: number;
  readonly otpFailed: number;
  readonly otpExpired: number;
  readonly otpLocked: number;
  readonly otpSuppressed: number;
  readonly otpRateLimited: number;
  readonly signinRateLimited: number;
  readonly deletionCodeSent: number;
  readonly deletionCodeVerified: number;
  readonly deletionCodeFailed: number;
  readonly deletionCodeLocked: number;
  readonly deletionCodeRateLimited: number;
}

export interface SecurityMonitoringDay {
  /** `YYYY-MM-DD` (UTC). */
  readonly date: string;
  readonly sent: number;
  readonly verified: number;
  readonly failed: number;
  readonly locked: number;
  readonly rateLimited: number;
}

export interface SecurityMonitoringSummary {
  readonly windowDays: number;
  readonly totals: SecurityMonitoringTotals;
  /** verified / (sent + resent); `null` when nothing was sent. */
  readonly verifyRate: number | null;
  readonly series: readonly SecurityMonitoringDay[];
  readonly generatedAt: string;
}

export interface SecurityEventItem {
  readonly id: string;
  readonly type: SecurityEventType;
  readonly surface: 'management' | 'academy' | null;
  readonly academy: { readonly id: string; readonly name: string | null } | null;
  /** `a•••@domain` for a known account; `null` for pre-auth events. */
  readonly maskedEmail: string | null;
  /** First 8 hex chars of the keyed subject hash — correlation only. */
  readonly subjectRef: string | null;
  /** First 8 hex chars of the monthly keyed IP hash — correlation only. */
  readonly ipRef: string | null;
  readonly reason: string | null;
  readonly attemptsRemaining: number | null;
  readonly occurrences: number;
  readonly createdAt: string;
}

export interface SecurityEventPage {
  readonly items: readonly SecurityEventItem[];
  readonly nextCursor: string | null;
}
