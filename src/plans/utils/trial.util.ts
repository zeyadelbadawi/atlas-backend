/**
 * Trial-lifecycle pure helpers — Phase 2 (Decision 6). Kept as small,
 * dependency-free functions (no I/O, no injected services) so both
 * `SubscriptionExpiryService` (the scheduled sweep that physically writes
 * `status: 'expired'`) and `EntitlementEnforcementService` (the live,
 * write-time check) can independently decide "is this trial over" from the
 * exact same rule, without one having to wait for the other to have run.
 *
 * This dual use is deliberate, not duplicated logic: the sweep makes the
 * expiry durable and visible everywhere (the Usage/Subscription pages, a
 * `GET` read) even for an organization that never attempts another write;
 * the live check closes the unavoidable gap between "the trial's clock ran
 * out" and "the next scheduled sweep tick actually flips the row" — a
 * caller inside that gap must still be rejected, never quietly let through
 * because the background job hasn't caught up yet (roadmap: "the trial
 * ... must transition automatically and reliably when it expires").
 */
import type { TenantSubscription } from '@prisma/client';

/**
 * True when a `'trialing'` subscription's clock has already run out, based
 * on its own `trialEndsAt`, regardless of whether the `status` column has
 * been physically updated to `'expired'` yet. Any other status returns
 * `false` — this function only ever answers "is the currently-`trialing`
 * period over," never a general "is this subscription usable" question
 * (see `EntitlementEnforcementService` for that broader decision, which
 * uses this as one input).
 */
export function isTrialPeriodOver(
  subscription: Pick<TenantSubscription, 'status' | 'trialEndsAt'>,
  now: Date,
): boolean {
  if (subscription.status !== 'trialing') return false;
  if (!subscription.trialEndsAt) return false;
  return subscription.trialEndsAt.getTime() <= now.getTime();
}
