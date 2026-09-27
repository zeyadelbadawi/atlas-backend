/**
 * New Customer Onboarding metrics — registered on the process-wide
 * `METRICS_REGISTRY` exactly like `CommunicationMetricsService`'s, so they
 * appear on `/metrics` and in the Observability Center with no new plumbing.
 * Plain functions rather than an injectable: the signup path lives in
 * `IdentityModule`, which must not import the metrics module's consumers.
 * Label values are closed vocabularies — never a user, plan or organization id.
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

export type SignupMetricMode = 'account' | 'organization';
export type SignupMetricOutcome =
  | 'created'
  | 'trial_started'
  | 'no_trial'
  | 'rejected_plan'
  | 'rejected_policy'
  | 'conflict'
  /** Launch Stabilization A4 — an existing account joined another academy through its signup. */
  | 'existing_account_joined';

const signups = counter(
  'atlas_signup_total',
  'Management-surface signups by mode and outcome (New Customer Onboarding).',
  ['mode', 'outcome'],
);

const onboardingCompleted = counter(
  'atlas_onboarding_completed_total',
  'Onboarding wizard exits: finished (all required steps done) or deferred ("Finish for now").',
  ['result'],
);

export function recordSignup(mode: SignupMetricMode, outcome: SignupMetricOutcome): void {
  signups.inc({ mode, outcome });
}

export function recordOnboardingCompleted(result: 'finished' | 'deferred'): void {
  onboardingCompleted.inc({ result });
}
