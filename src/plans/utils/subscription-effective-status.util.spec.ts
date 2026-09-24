/**
 * `resolveEffectiveSubscriptionStatus` — the one rule both the live access
 * check and the expiry sweep derive a subscription's state from.
 *
 * Every dated transition is asserted at three instants: exactly at the
 * boundary, 1 ms before and 1 ms after. "At" is over (`<= now`), matching
 * `isTrialPeriodOver`; a test that only checked "an hour later" would let
 * an off-by-one at the boundary through, and the boundary is where a
 * customer's last request before expiry actually lands.
 */
import {
  resolveEffectiveSubscriptionStatus,
  resolveGraceEndsAt,
  type EffectiveStatusInput,
} from './subscription-effective-status.util';
import { GRACE_PERIOD_DAYS, GRACE_PERIOD_MS } from '../queue/subscription-sweep.types';

const T = new Date('2026-09-24T12:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

function sub(overrides: Partial<EffectiveStatusInput>): EffectiveStatusInput {
  return {
    status: 'active',
    trialEndsAt: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe('resolveEffectiveSubscriptionStatus', () => {
  it('the grace window is exactly seven days', () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
    expect(GRACE_PERIOD_MS).toBe(7 * DAY);
  });

  describe('trialing', () => {
    const trial = sub({ status: 'trialing', trialEndsAt: T });

    it('is trialing 1 ms before trialEndsAt, with effectiveUntil = trialEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(trial, at(-1))).toEqual({
        effectiveStatus: 'trialing',
        effectiveUntil: T,
        reason: 'stored',
      });
    });

    it('is trial_expired exactly at trialEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(trial, at(0))).toEqual({
        effectiveStatus: 'trial_expired',
        reason: 'trial_clock_elapsed',
      });
    });

    it('is trial_expired 1 ms after trialEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(trial, at(1)).effectiveStatus).toBe(
        'trial_expired',
      );
    });

    it('an undated trial stays trialing with no effectiveUntil', () => {
      expect(
        resolveEffectiveSubscriptionStatus(
          sub({ status: 'trialing', trialEndsAt: null }),
          at(365 * DAY),
        ),
      ).toEqual({ effectiveStatus: 'trialing', reason: 'stored' });
    });
  });

  describe('active', () => {
    const paid = sub({ status: 'active', currentPeriodEnd: T });

    it('is active 1 ms before currentPeriodEnd, with effectiveUntil = currentPeriodEnd', () => {
      expect(resolveEffectiveSubscriptionStatus(paid, at(-1))).toEqual({
        effectiveStatus: 'active',
        effectiveUntil: T,
        reason: 'stored',
      });
    });

    it('enters grace exactly at currentPeriodEnd, ending 7 days later', () => {
      expect(resolveEffectiveSubscriptionStatus(paid, at(0))).toEqual({
        effectiveStatus: 'grace_period',
        effectiveUntil: at(GRACE_PERIOD_MS),
        graceEndsAt: at(GRACE_PERIOD_MS),
        reason: 'period_ended_grace',
      });
    });

    it('is in grace 1 ms after currentPeriodEnd', () => {
      expect(resolveEffectiveSubscriptionStatus(paid, at(1)).effectiveStatus).toBe(
        'grace_period',
      );
    });

    it('is still in grace 1 ms before the derived grace end', () => {
      const result = resolveEffectiveSubscriptionStatus(paid, at(GRACE_PERIOD_MS - 1));
      expect(result.effectiveStatus).toBe('grace_period');
      expect(result.graceEndsAt).toEqual(at(GRACE_PERIOD_MS));
    });

    it('is expired exactly at the derived grace end (sweep never ran)', () => {
      expect(resolveEffectiveSubscriptionStatus(paid, at(GRACE_PERIOD_MS))).toEqual({
        effectiveStatus: 'expired',
        graceEndsAt: at(GRACE_PERIOD_MS),
        reason: 'grace_ended',
      });
    });

    it('is expired 1 ms after the derived grace end', () => {
      expect(
        resolveEffectiveSubscriptionStatus(paid, at(GRACE_PERIOD_MS + 1)).effectiveStatus,
      ).toBe('expired');
    });

    it('prefers a stored graceEndsAt over the derived one', () => {
      const stored = sub({
        status: 'active',
        currentPeriodEnd: T,
        graceEndsAt: at(2 * DAY),
      });
      expect(resolveEffectiveSubscriptionStatus(stored, at(2 * DAY - 1))).toMatchObject({
        effectiveStatus: 'grace_period',
        graceEndsAt: at(2 * DAY),
      });
      expect(resolveEffectiveSubscriptionStatus(stored, at(2 * DAY))).toMatchObject({
        effectiveStatus: 'expired',
        graceEndsAt: at(2 * DAY),
      });
    });

    describe('with cancelAtPeriodEnd', () => {
      const cancelling = sub({
        status: 'active',
        currentPeriodEnd: T,
        cancelAtPeriodEnd: true,
      });

      it('keeps working 1 ms before currentPeriodEnd', () => {
        expect(resolveEffectiveSubscriptionStatus(cancelling, at(-1))).toEqual({
          effectiveStatus: 'active',
          effectiveUntil: T,
          reason: 'stored',
        });
      });

      it('is cancelled exactly at currentPeriodEnd — no grace', () => {
        expect(resolveEffectiveSubscriptionStatus(cancelling, at(0))).toEqual({
          effectiveStatus: 'cancelled',
          reason: 'period_ended_cancel_at_period_end',
        });
      });

      it('is cancelled 1 ms after currentPeriodEnd, and never enters grace later', () => {
        expect(
          resolveEffectiveSubscriptionStatus(cancelling, at(1)).effectiveStatus,
        ).toBe('cancelled');
        expect(
          resolveEffectiveSubscriptionStatus(cancelling, at(3 * DAY)).effectiveStatus,
        ).toBe('cancelled');
      });
    });

    it('an active row with no currentPeriodEnd never expires by clock', () => {
      expect(
        resolveEffectiveSubscriptionStatus(
          sub({ status: 'active', currentPeriodEnd: null }),
          at(10 * 365 * DAY),
        ),
      ).toEqual({ effectiveStatus: 'active', reason: 'stored' });
    });
  });

  describe('grace_period (already persisted by the sweep)', () => {
    const grace = sub({
      status: 'grace_period',
      currentPeriodEnd: at(-3 * DAY),
      graceEndsAt: T,
    });

    it('is grace_period 1 ms before graceEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(grace, at(-1))).toEqual({
        effectiveStatus: 'grace_period',
        effectiveUntil: T,
        graceEndsAt: T,
        reason: 'stored',
      });
    });

    it('is expired exactly at graceEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(grace, at(0))).toEqual({
        effectiveStatus: 'expired',
        graceEndsAt: T,
        reason: 'grace_ended',
      });
    });

    it('is expired 1 ms after graceEndsAt', () => {
      expect(resolveEffectiveSubscriptionStatus(grace, at(1)).effectiveStatus).toBe(
        'expired',
      );
    });

    it('derives graceEndsAt from currentPeriodEnd when the stored value is missing', () => {
      const derived = sub({
        status: 'grace_period',
        currentPeriodEnd: T,
        graceEndsAt: null,
      });
      expect(
        resolveEffectiveSubscriptionStatus(derived, at(GRACE_PERIOD_MS - 1)),
      ).toMatchObject({
        effectiveStatus: 'grace_period',
        graceEndsAt: at(GRACE_PERIOD_MS),
      });
      expect(
        resolveEffectiveSubscriptionStatus(derived, at(GRACE_PERIOD_MS)).effectiveStatus,
      ).toBe('expired');
    });

    it('an undated grace row stays grace_period', () => {
      expect(
        resolveEffectiveSubscriptionStatus(
          sub({ status: 'grace_period', currentPeriodEnd: null, graceEndsAt: null }),
          at(365 * DAY),
        ),
      ).toEqual({ effectiveStatus: 'grace_period', reason: 'stored' });
    });
  });

  describe('every other status is returned unchanged', () => {
    it.each([
      'no_plan',
      'trial_expired',
      'past_due',
      'paused',
      'cancelled',
      'expired',
    ] as const)('%s', (status) => {
      expect(
        resolveEffectiveSubscriptionStatus(
          sub({
            status,
            currentPeriodEnd: at(-DAY),
            trialEndsAt: at(-DAY),
            graceEndsAt: at(-DAY),
          }),
          at(0),
        ),
      ).toEqual({ effectiveStatus: status, reason: 'stored' });
    });
  });

  describe('resolveGraceEndsAt', () => {
    it('is the stored value when present', () => {
      expect(resolveGraceEndsAt({ currentPeriodEnd: T, graceEndsAt: at(DAY) })).toEqual(
        at(DAY),
      );
    });
    it('is currentPeriodEnd + 7 days otherwise', () => {
      expect(resolveGraceEndsAt({ currentPeriodEnd: T, graceEndsAt: null })).toEqual(
        at(GRACE_PERIOD_MS),
      );
    });
    it('is null with neither', () => {
      expect(
        resolveGraceEndsAt({ currentPeriodEnd: null, graceEndsAt: null }),
      ).toBeNull();
    });
  });
});
