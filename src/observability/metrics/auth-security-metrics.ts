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

/** A3 — what ended every session of an account. */
export type SessionRevocationTrigger = 'password_reset' | 'password_change';

const surfaceDenied = counter(
  'atlas_auth_surface_denied_total',
  'Requests refused because the session was minted on another surface or academy (Launch Stabilization A1). Any increase means a token is being used outside the website it was issued to.',
  ['reason'],
);

const sessionsRevoked = counter(
  'atlas_auth_sessions_revoked_total',
  'Sessions ended because the account password was reset or changed (Launch Stabilization A3).',
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
