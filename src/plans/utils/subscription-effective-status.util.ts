/**
 * The EFFECTIVE status of a subscription at an instant — what the row
 * would say if the expiry sweep had run at exactly `now`.
 *
 * THE DEFECT THIS CLOSES. `status` is written by the sweep, which runs
 * every 15 minutes, and until this utility existed the paid half of the
 * lifecycle was never written at all: nothing read `currentPeriodEnd`, so
 * an `active` row stayed `active` — with full access — forever, and
 * `cancelAtPeriodEnd` was recorded and never acted on. Trials were
 * already protected by `isTrialPeriodOver`, which checks the clock as
 * well as the column; this generalises that rule to every dated state,
 * so an access decision never depends on a background job having run.
 *
 * PURE ON PURPOSE. No I/O, no injected services, no `new Date()`: both
 * the live access check (`SubscriptionAccessService`,
 * `EntitlementEnforcementService`) and the sweep that makes the
 * transition durable (`SubscriptionExpiryService`) call this exact
 * function, so what the sweep persists and what a request sees between
 * ticks can never disagree.
 *
 * Rules, in order:
 *   trialing      past trialEndsAt      -> trial_expired
 *   active        past currentPeriodEnd -> cancelled   (cancelAtPeriodEnd)
 *                                       -> grace_period (otherwise; ends at
 *                                          stored graceEndsAt, or
 *                                          currentPeriodEnd + 7 days)
 *                                       -> expired     (grace also over)
 *   grace_period  past graceEndsAt      -> expired
 *   anything else                       -> unchanged
 *
 * "Past" is `<= now`: a period that ends at T is over AT T, exactly as
 * `isTrialPeriodOver` already defines it for trials.
 */
import type { TenantSubscription } from '@prisma/client';
import { GRACE_PERIOD_MS } from '../queue/subscription-sweep.types';
import { isTrialPeriodOver } from './trial.util';

export type EffectiveSubscriptionStatus = TenantSubscription['status'];

export type EffectiveStatusReason =
  /** The stored status stands. */
  | 'stored'
  | 'trial_clock_elapsed'
  | 'period_ended_cancel_at_period_end'
  | 'period_ended_grace'
  | 'grace_ended';

export type EffectiveStatusInput = Pick<
  TenantSubscription,
  'status' | 'trialEndsAt' | 'currentPeriodEnd' | 'graceEndsAt' | 'cancelAtPeriodEnd'
>;

export interface EffectiveSubscriptionStatusResult {
  readonly effectiveStatus: EffectiveSubscriptionStatus;
  /**
   * When the EFFECTIVE state ends on its own, if it is dated: `trialEndsAt`
   * for a trial, `currentPeriodEnd` for a live paid period, `graceEndsAt`
   * during grace. Absent for terminal and undated states.
   */
  readonly effectiveUntil?: Date;
  /** The grace window's end, whenever one applies (stored, or derived from `currentPeriodEnd`). */
  readonly graceEndsAt?: Date;
  readonly reason: EffectiveStatusReason;
}

function isPast(at: Date | null | undefined, now: Date): at is Date {
  return !!at && at.getTime() <= now.getTime();
}

/** The grace window for a paid period: the stored value when the sweep already set one, else derived. */
export function resolveGraceEndsAt(
  subscription: Pick<TenantSubscription, 'currentPeriodEnd' | 'graceEndsAt'>,
): Date | null {
  if (subscription.graceEndsAt) return subscription.graceEndsAt;
  if (!subscription.currentPeriodEnd) return null;
  return new Date(subscription.currentPeriodEnd.getTime() + GRACE_PERIOD_MS);
}

export function resolveEffectiveSubscriptionStatus(
  subscription: EffectiveStatusInput,
  now: Date,
): EffectiveSubscriptionStatusResult {
  switch (subscription.status) {
    case 'trialing': {
      if (isTrialPeriodOver(subscription, now)) {
        return { effectiveStatus: 'trial_expired', reason: 'trial_clock_elapsed' };
      }
      return {
        effectiveStatus: 'trialing',
        reason: 'stored',
        ...(subscription.trialEndsAt ? { effectiveUntil: subscription.trialEndsAt } : {}),
      };
    }

    case 'active': {
      if (!isPast(subscription.currentPeriodEnd, now)) {
        return {
          effectiveStatus: 'active',
          reason: 'stored',
          ...(subscription.currentPeriodEnd
            ? { effectiveUntil: subscription.currentPeriodEnd }
            : {}),
        };
      }
      if (subscription.cancelAtPeriodEnd) {
        return {
          effectiveStatus: 'cancelled',
          reason: 'period_ended_cancel_at_period_end',
        };
      }
      // `currentPeriodEnd` is set (it is what `isPast` just matched), so a
      // grace end can always be derived from it.
      const graceEndsAt =
        subscription.graceEndsAt ??
        new Date(subscription.currentPeriodEnd.getTime() + GRACE_PERIOD_MS);
      if (isPast(graceEndsAt, now)) {
        return { effectiveStatus: 'expired', graceEndsAt, reason: 'grace_ended' };
      }
      return {
        effectiveStatus: 'grace_period',
        effectiveUntil: graceEndsAt,
        graceEndsAt,
        reason: 'period_ended_grace',
      };
    }

    case 'grace_period': {
      const graceEndsAt = resolveGraceEndsAt(subscription);
      if (isPast(graceEndsAt, now)) {
        return { effectiveStatus: 'expired', graceEndsAt, reason: 'grace_ended' };
      }
      return {
        effectiveStatus: 'grace_period',
        reason: 'stored',
        ...(graceEndsAt ? { effectiveUntil: graceEndsAt, graceEndsAt } : {}),
      };
    }

    default:
      return { effectiveStatus: subscription.status, reason: 'stored' };
  }
}
