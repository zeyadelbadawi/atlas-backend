/**
 * Smart member invitation / academy join — registered on the process-wide
 * `METRICS_REGISTRY` exactly like `onboarding-metrics.ts`, so the series
 * appear on `/metrics` with no new plumbing. Plain functions: the academy
 * and identity services call them without new constructor dependencies.
 * Label values are closed vocabularies — never an email, user or academy id.
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

/** What the staff member lookup answered (or why it did not). */
export type MemberLookupResult =
  | 'new'
  | 'existing'
  | 'pending_setup'
  | 'already_member'
  | 'unavailable'
  | 'denied'
  | 'rate_limited';

/** The role a member was added with. */
export type MemberAddRole = 'manager' | 'instructor' | 'student';

/**
 * What kind of account a successful add resolved to:
 *  - `new`: an invited account was created (setup email);
 *  - `existing`: an active account was added (added notice);
 *  - `pending_setup`: an account that never finished setup (setup email again).
 */
export type MemberAddAccount = 'new' | 'existing' | 'pending_setup';

/**
 * How a public `POST /auth/academy-join` ended:
 *  - `joined`: the existing account became a learner here;
 *  - `already_learner`: it already was one (or a concurrent join won);
 *  - `invalid_credentials`: unknown email, wrong password, invited or deleted;
 *  - `refused`: suspended, blocked here, or the academy refused the admission.
 */
export type AcademyJoinResult =
  'joined' | 'already_learner' | 'invalid_credentials' | 'refused';

const lookups = counter(
  'atlas_member_lookup_total',
  'Staff member-invitation email lookups by outcome (UX only; the add call re-checks everything).',
  ['result'],
);

const adds = counter(
  'atlas_member_add_total',
  'Members added by staff, by role and by what kind of account the email resolved to.',
  ['role', 'account'],
);

const addRaces = counter(
  'atlas_member_add_race_total',
  'Member adds that collided with a concurrent add of the same email or membership and were reconciled.',
  ['role'],
);

const academyJoins = counter(
  'atlas_academy_join_total',
  'Existing-account academy joins from the public signup page, by outcome.',
  ['result'],
);

export function recordAcademyJoin(result: AcademyJoinResult): void {
  academyJoins.inc({ result });
}

export function recordMemberLookup(result: MemberLookupResult): void {
  lookups.inc({ result });
}

export function recordMemberAdd(role: MemberAddRole, account: MemberAddAccount): void {
  adds.inc({ role, account });
}

export function recordMemberAddRace(role: MemberAddRole): void {
  addRaces.inc({ role });
}
