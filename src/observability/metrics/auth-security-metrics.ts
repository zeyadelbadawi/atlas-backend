/**
 * Launch Stabilization Plan A — authentication security signals, registered
 * on the process-wide `METRICS_REGISTRY` exactly like `onboarding-metrics.ts`,
 * so they appear on `/metrics` (and can be alerted on in
 * `ops/alerts/atlas-prometheus-rules.yml`) with no new plumbing. Plain
 * functions rather than an injectable: guards in `IdentityModule` and
 * `TenancyModule` call them without new constructor dependencies.
 * Label values are closed vocabularies — never a user, session or academy id.
 */
import { Counter } from 'prom-client';
import { METRICS_REGISTRY } from './learning-metrics.service';

function counter(name: string, help: string, labelNames: readonly string[]): Counter {
  const existing = METRICS_REGISTRY.getSingleMetric(name);
  if (existing) return existing as Counter;
  return new Counter({
    name,
    help,
    labelNames: [...labelNames],
    registers: [METRICS_REGISTRY],
  });
}

/**
 * Why a session was refused because of the surface it was minted on (A1):
 *  - `management_route`: a non-management session on a `ManagementSurfaceGuard` route;
 *  - `platform_owner_route`: the same on a `PlatformOwnerGuard` route;
 *  - `account_action`: the same on a `ManagementSessionGuard` account action;
 *  - `academy_host_mismatch`: an academy session used on ANOTHER academy's host.
 */
export type SurfaceDenialReason =
  | 'management_route'
  | 'platform_owner_route'
  | 'account_action'
  | 'academy_host_mismatch';

/**
 * What ended sessions: A3's password reset/change (every session of the
 * account), or a rotated refresh token presented again after the multi-tab
 * grace (that one session family — two parties hold it).
 */
export type SessionRevocationTrigger =
  | 'password_reset'
  | 'password_change'
  | 'refresh_token_reuse'
  // ATO review F1 — an unverified account returned to `invited` before a
  // grant by someone else reached it.
  | 'unverified_account_grant'
  // ATO review F3 — two-factor authentication turned off: every OTHER
  // session ends with it.
  | 'two_factor_disabled';

const surfaceDenied = counter(
  'atlas_auth_surface_denied_total',
  'Requests refused because the session was minted on another surface or academy (Launch Stabilization A1). Any increase means a token is being used outside the website it was issued to.',
  ['reason'],
);

const sessionsRevoked = counter(
  'atlas_auth_sessions_revoked_total',
  'Sessions ended because the account password was reset or changed (A3), or because a rotated refresh token was replayed (trigger="refresh_token_reuse" — possible token theft).',
  ['trigger'],
);

export function recordSurfaceDenied(reason: SurfaceDenialReason): void {
  surfaceDenied.inc({ reason });
}

export function recordSessionsRevoked(
  trigger: SessionRevocationTrigger,
  count: number,
): void {
  // `inc(0)` still creates the labelled series, so a reset with no live
  // session is visible as a zero-valued sample rather than as absence.
  sessionsRevoked.inc({ trigger }, count);
}

/**
 * Production-readiness pass — every authentication REFUSAL, by its
 * `errors.auth.*` message key. Recorded once, centrally, by the global
 * exception filter, so no throw site can forget it and no second counting
 * path exists. The key set is the code's own constant vocabulary (bounded;
 * anything not shaped like one is folded into `other`), never user input.
 *
 * What it detects: brute force (`invalidCredentials`, `rateLimited`), TOTP
 * guessing (`invalidTwoFactorCode`), reset-link abuse (`invalidResetToken`),
 * stolen/replayed refresh cookies (`invalidRefreshToken`,
 * `crossOriginSession`), email-code guessing (`otpInvalid`), tenancy probing
 * (`academyHostMismatch`, `studentUseAcademySignIn`).
 */
const authRefusals = counter(
  'atlas_auth_refusals_total',
  'Authentication requests refused, by errors.auth.* message key (brute force, TOTP/OTP guessing, reset abuse, refresh replay, cross-origin session use).',
  ['key'],
);

const AUTH_KEY = /^errors\.auth\.[A-Za-z]{1,48}$/;

export function recordAuthRefusal(messageKey: string): void {
  if (!messageKey.startsWith('errors.auth.')) return;
  authRefusals.inc({
    key: AUTH_KEY.test(messageKey) ? messageKey.slice('errors.auth.'.length) : 'other',
  });
}
