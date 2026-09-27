/**
 * Google Identity — registered on the process-wide `METRICS_REGISTRY` like
 * `member-metrics.ts`. Label values are closed vocabularies: never an email,
 * a Google subject, a user or an academy id.
 */
import { Counter } from 'prom-client';
import { METRICS_REGISTRY } from './learning-metrics.service';

/** Where in the flow the outcome was decided. */
export type GoogleAuthStage = 'authorize' | 'callback' | 'complete';

/**
 * How a stage ended:
 *  - `started`: an authorization URL was handed out;
 *  - `cancelled`: the person backed out at Google;
 *  - `provider_error`: Google could not be reached or refused the code;
 *  - `invalid_state`: an unknown, expired or replayed state/handoff/binder;
 *  - `invalid_token`: the ID token failed verification (signature, issuer,
 *    audience, expiry or nonce);
 *  - `unverified_email`: Google does not vouch for the address;
 *  - `existing_identity`: the Google account was already linked, and the
 *    sign-in continued through the normal pipeline;
 *  - `link_required`: the address belongs to an Atlas account that has not
 *    connected Google — the owner must prove the account first;
 *  - `create_account`: no Atlas account — the explicit create step follows;
 *  - `activate_invited`: an invited account the Google address may activate;
 *  - `refused`: the pipeline refused (suspended, surface, not a member …);
 *  - `rate_limited`, `disabled`.
 */
export type GoogleAuthResult =
  | 'started'
  | 'cancelled'
  | 'provider_error'
  | 'invalid_state'
  | 'invalid_token'
  | 'unverified_email'
  | 'existing_identity'
  | 'link_required'
  | 'create_account'
  | 'activate_invited'
  | 'refused'
  | 'rate_limited'
  | 'disabled';

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

const googleAuth = counter(
  'atlas_google_auth_total',
  'Google sign-in flow outcomes by stage.',
  ['stage', 'result'],
);

export function recordGoogleAuth(stage: GoogleAuthStage, result: GoogleAuthResult): void {
  googleAuth.inc({ stage, result });
}
