/**
 * The §26/§27 sequence evaluator, asserted as the pure function it is.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE E2E SUITE. Every rule in §26
 * and §27 is a condition on (one subscription row, one cancellation
 * record, one instant). Proving them through HTTP and a database would
 * prove the wiring, not the rules, and would make each boundary case cost
 * a fixture. Here a boundary is two assertions 1 ms apart — the same
 * discipline `subscription-effective-status.util.spec.ts` already applies
 * to the status it derives, and for the same reason: an access decision
 * (and now a customer-facing email) must not depend on when a job ran.
 *
 * The e2e suite covers what this cannot: that a repeated sweep writes one
 * row, that preferences and anonymised recipients are honoured, and that
 * the emitted keys really are rejected by the unique index.
 */
import type { TenantSubscription } from '@prisma/client';
import {
  LIFECYCLE_SHORT_NOTICE_LATENESS_MS,
  LIFECYCLE_STEP_MAX_LATENESS_MS,
  evaluateLifecycleSteps,
  resolveLifecyclePhase,
  type LifecycleEvaluationInput,
  type LifecycleStepId,
} from './lifecycle-steps.util';
import {
  GRACE_PERIOD_MS,
  SUBSCRIPTION_SWEEP_INTERVAL_MS,
} from '../queue/subscription-sweep.types';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** The real sweep cadence — the walk below ticks at exactly this interval. */
const TICK = SUBSCRIPTION_SWEEP_INTERVAL_MS;

const TRIAL_ENDS_AT = new Date('2026-10-04T12:00:00.000Z');
const PERIOD_END = new Date('2026-11-01T12:00:00.000Z');
const GRACE_END = new Date(PERIOD_END.getTime() + GRACE_PERIOD_MS);

type Subscription = LifecycleEvaluationInput['subscription'];

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    status: 'trialing' as TenantSubscription['status'],
    trialEndsAt: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function input(
  sub: Partial<Subscription>,
  cancellations: Partial<Omit<LifecycleEvaluationInput, 'subscription'>> = {},
): LifecycleEvaluationInput {
  return {
    subscription: subscription(sub),
    trialCancelledAt: null,
    paidCancelledAt: null,
    ...cancellations,
  };
}

function stepsAt(evaluation: LifecycleEvaluationInput, now: Date): LifecycleStepId[] {
  return evaluateLifecycleSteps(evaluation, now).map((step) => step.step);
}

/** 1 ms before an instant, and exactly at it — the two assertions every timing claim needs. */
function justBefore(at: Date): Date {
  return new Date(at.getTime() - 1);
}

describe('lifecycle sequence evaluator (§26 trial, §27 subscription)', () => {
  describe('T2 — trial ends tomorrow', () => {
    const trialing = input({ status: 'trialing', trialEndsAt: TRIAL_ENDS_AT });
    const dueAt = new Date(TRIAL_ENDS_AT.getTime() - 24 * HOUR);

    it('does not fire 1 ms before `trialEndsAt − 24 h`', () => {
      expect(stepsAt(trialing, justBefore(dueAt))).toEqual([]);
    });

    it('fires exactly at `trialEndsAt − 24 h`', () => {
      expect(stepsAt(trialing, dueAt)).toEqual(['trial_ending_soon']);
    });

    it('stops the moment the trial is over — a "ends tomorrow" mail can never arrive after it ended', () => {
      expect(stepsAt(trialing, TRIAL_ENDS_AT)).toEqual(['trial_expired']);
    });

    it('is not sent to someone who already cancelled their trial', () => {
      const cancelled = input(
        { status: 'trialing', trialEndsAt: TRIAL_ENDS_AT },
        { trialCancelledAt: new Date(dueAt.getTime() - HOUR) },
      );
      expect(stepsAt(cancelled, dueAt)).toEqual([]);
    });
  });

  describe('T3 — trial expired', () => {
    const expired = input({ status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT });

    it('does not fire 1 ms before the trial ends', () => {
      const trialing = input({ status: 'trialing', trialEndsAt: TRIAL_ENDS_AT });
      expect(stepsAt(trialing, justBefore(TRIAL_ENDS_AT))).not.toContain('trial_expired');
    });

    it('fires exactly at expiry, from the stored status or from the clock alone', () => {
      expect(stepsAt(expired, TRIAL_ENDS_AT)).toEqual(['trial_expired']);
      // The sweep has not run yet: the row still says `trialing`, and the
      // step is due anyway. The email must not wait for a job.
      const notSweptYet = input({ status: 'trialing', trialEndsAt: TRIAL_ENDS_AT });
      expect(stepsAt(notSweptYet, TRIAL_ENDS_AT)).toEqual(['trial_expired']);
    });

    it('is the ONLY step a cancelled trial ever gets — anchored on the cancellation, not on `trialEndsAt`', () => {
      const cancelledAt = new Date(TRIAL_ENDS_AT.getTime() - 2 * DAY);
      const cancelled = input(
        { status: 'cancelled', trialEndsAt: TRIAL_ENDS_AT },
        { trialCancelledAt: cancelledAt },
      );
      const due = evaluateLifecycleSteps(cancelled, cancelledAt);
      expect(due.map((step) => step.step)).toEqual(['trial_expired']);
      expect(due[0].anchorAt).toEqual(cancelledAt);

      // …and none of T4–T6, at any later point in the sequence.
      for (const offset of [3 * DAY, 14 * DAY, 45 * DAY]) {
        expect(stepsAt(cancelled, new Date(cancelledAt.getTime() + offset))).toEqual([]);
      }
    });

    it('stops being due once it is more than the lateness horizon old', () => {
      const late = new Date(TRIAL_ENDS_AT.getTime() + LIFECYCLE_STEP_MAX_LATENESS_MS + 1);
      expect(stepsAt(expired, late)).toEqual([]);
      expect(
        stepsAt(
          expired,
          new Date(TRIAL_ENDS_AT.getTime() + LIFECYCLE_STEP_MAX_LATENESS_MS),
        ),
      ).toEqual(['trial_expired']);
    });
  });

  describe('the lateness horizons', () => {
    it('gives a "tomorrow" reminder a much shorter grace than a terminal step', () => {
      // S4 says "your period ends tomorrow". Emitted a day late it would
      // arrive minutes before the period actually ends — not late, wrong.
      const active = input({ status: 'active', currentPeriodEnd: PERIOD_END });
      const s4DueAt = new Date(PERIOD_END.getTime() - DAY);
      expect(
        stepsAt(active, new Date(s4DueAt.getTime() + LIFECYCLE_SHORT_NOTICE_LATENESS_MS)),
      ).toContain('subscription_renewal_tomorrow');
      expect(
        stepsAt(
          active,
          new Date(s4DueAt.getTime() + LIFECYCLE_SHORT_NOTICE_LATENESS_MS + 1),
        ),
      ).not.toContain('subscription_renewal_tomorrow');

      // A terminal step carries the full horizon: "your site is offline"
      // is still true whenever it is read.
      const expired = input({ status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT });
      expect(
        stepsAt(
          expired,
          new Date(TRIAL_ENDS_AT.getTime() + LIFECYCLE_SHORT_NOTICE_LATENESS_MS + 1),
        ),
      ).toContain('trial_expired');
    });

    it('applies the short horizon to T2 and S6 as well', () => {
      const trialing = input({ status: 'trialing', trialEndsAt: TRIAL_ENDS_AT });
      const t2DueAt = new Date(TRIAL_ENDS_AT.getTime() - DAY);
      expect(
        stepsAt(
          trialing,
          new Date(t2DueAt.getTime() + LIFECYCLE_SHORT_NOTICE_LATENESS_MS + 1),
        ),
      ).toEqual([]);

      const inGrace = input({
        status: 'grace_period',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      const s6DueAt = new Date(GRACE_END.getTime() - DAY);
      expect(
        stepsAt(
          inGrace,
          new Date(s6DueAt.getTime() + LIFECYCLE_SHORT_NOTICE_LATENESS_MS + 1),
        ),
      ).toEqual([]);
    });
  });

  describe('T4/T5/T6 — the conditional tail', () => {
    const lapsed = input({ status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT });
    const at = (offset: number): Date => new Date(TRIAL_ENDS_AT.getTime() + offset);

    it.each([
      [3 * DAY, 'trial_followup_3d'],
      [14 * DAY, 'trial_followup_14d'],
      [45 * DAY, 'trial_reactivation_45d'],
    ] as const)('fires at expiry + %i ms and not 1 ms earlier', (offset, step) => {
      expect(stepsAt(lapsed, justBefore(at(offset)))).not.toContain(step);
      expect(stepsAt(lapsed, at(offset))).toContain(step);
    });

    it('marks only T5 and T6 as needing content — an empty account gets T4 and nothing more', () => {
      const t4 = evaluateLifecycleSteps(lapsed, at(3 * DAY));
      expect(t4.map((s) => s.requiresContent)).toEqual([false]);
      expect(evaluateLifecycleSteps(lapsed, at(14 * DAY))[0].requiresContent).toBe(true);
      expect(evaluateLifecycleSteps(lapsed, at(45 * DAY))[0].requiresContent).toBe(true);
    });

    it('stops instantly on activation — nothing has to be cancelled, the step simply is not due', () => {
      // A period end far past T6, so this case tests ONLY that the trial
      // tail stops — not that a paid period that itself lapses starts the
      // §27 sequence (which it should, and does: see the walk below).
      const activated = input({
        status: 'active',
        trialEndsAt: TRIAL_ENDS_AT,
        currentPeriodEnd: new Date(TRIAL_ENDS_AT.getTime() + 365 * DAY),
      });
      for (const offset of [3 * DAY, 14 * DAY, 45 * DAY]) {
        expect(stepsAt(activated, at(offset))).toEqual([]);
      }
    });

    it('stops if a cancellation of either kind was recorded', () => {
      const withTrialCancel = input(
        { status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT },
        { trialCancelledAt: TRIAL_ENDS_AT },
      );
      const withPaidCancel = input(
        { status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT },
        { paidCancelledAt: TRIAL_ENDS_AT },
      );
      expect(stepsAt(withTrialCancel, at(3 * DAY))).toEqual([]);
      expect(stepsAt(withPaidCancel, at(3 * DAY))).toEqual([]);
    });

    it('sends nothing at +7 d, +30 d or +60 d — the plan lists those as deliberately absent', () => {
      for (const offset of [7 * DAY, 30 * DAY, 60 * DAY]) {
        expect(stepsAt(lapsed, at(offset))).toEqual([]);
      }
    });
  });

  describe('S3/S4 — renewal reminders', () => {
    const active = input({
      status: 'active',
      currentPeriodEnd: PERIOD_END,
    });

    it('fires S3 at `currentPeriodEnd − 7 d` and not 1 ms earlier', () => {
      const dueAt = new Date(PERIOD_END.getTime() - 7 * DAY);
      expect(stepsAt(active, justBefore(dueAt))).toEqual([]);
      expect(stepsAt(active, dueAt)).toEqual(['subscription_renewal_due']);
    });

    it('fires S4 at `currentPeriodEnd − 1 d`', () => {
      const dueAt = new Date(PERIOD_END.getTime() - DAY);
      expect(stepsAt(active, justBefore(dueAt))).not.toContain(
        'subscription_renewal_tomorrow',
      );
      expect(stepsAt(active, dueAt)).toContain('subscription_renewal_tomorrow');
    });

    it('is skipped once paid — a renewal moves `currentPeriodEnd`, so the old reminders are not due and the new ones are in the future', () => {
      const renewed = input({
        status: 'active',
        currentPeriodEnd: new Date(PERIOD_END.getTime() + 30 * DAY),
      });
      expect(stepsAt(renewed, new Date(PERIOD_END.getTime() - 7 * DAY))).toEqual([]);
      expect(stepsAt(renewed, new Date(PERIOD_END.getTime() - DAY))).toEqual([]);
    });

    it('is skipped for a subscription already set to cancel at period end — S8 already told them', () => {
      const cancelling = input({
        status: 'active',
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: true,
      });
      expect(stepsAt(cancelling, new Date(PERIOD_END.getTime() - 7 * DAY))).toEqual([]);
    });
  });

  describe('S5/S6/S7 — grace and expiry', () => {
    const active = input({ status: 'active', currentPeriodEnd: PERIOD_END });

    it('emits S5 at the period end and S7 at the grace end, in that order and never the reverse', () => {
      expect(stepsAt(active, justBefore(PERIOD_END))).not.toContain(
        'subscription_grace_started',
      );
      expect(stepsAt(active, PERIOD_END)).toEqual(['subscription_grace_started']);

      const inGrace = input({
        status: 'grace_period',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      expect(stepsAt(inGrace, justBefore(GRACE_END))).not.toContain(
        'subscription_expired',
      );

      const expired = input({
        status: 'expired',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      expect(stepsAt(expired, GRACE_END)).toContain('subscription_expired');
      // And the earlier message is never sent afterwards: telling someone
      // their site is in a grace window that already closed is a lie.
      expect(stepsAt(expired, GRACE_END)).not.toContain('subscription_grace_started');
    });

    it('emits S6 one day before the grace window closes', () => {
      const inGrace = input({
        status: 'grace_period',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      const dueAt = new Date(GRACE_END.getTime() - DAY);
      expect(stepsAt(inGrace, justBefore(dueAt))).not.toContain(
        'subscription_grace_ending',
      );
      expect(stepsAt(inGrace, dueAt)).toContain('subscription_grace_ending');
    });

    it('anchors S5 on the period end and S6/S7 on the grace end, so the three can never collide on one key', () => {
      const inGrace = input({
        status: 'grace_period',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      // Each anchor is asserted where that step is actually due — S5 is
      // six days past its window by the time S6 falls due, which is the
      // lateness horizon doing its job, not a missing step.
      expect(evaluateLifecycleSteps(inGrace, PERIOD_END)[0]).toMatchObject({
        step: 'subscription_grace_started',
        anchorAt: PERIOD_END,
      });
      expect(
        evaluateLifecycleSteps(inGrace, new Date(GRACE_END.getTime() - DAY))[0],
      ).toMatchObject({ step: 'subscription_grace_ending', anchorAt: GRACE_END });
      const expired = input({
        status: 'expired',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      expect(evaluateLifecycleSteps(expired, GRACE_END)[0]).toMatchObject({
        step: 'subscription_expired',
        anchorAt: GRACE_END,
      });
    });
  });

  describe('S9/S10 — cancellation and post-expiry follow-ups', () => {
    it('emits S9 when a paid cancellation becomes effective, anchored on the cancellation itself', () => {
      const cancelled = input(
        {
          status: 'cancelled',
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: true,
        },
        { paidCancelledAt: PERIOD_END },
      );
      const due = evaluateLifecycleSteps(cancelled, PERIOD_END);
      expect(due.map((s) => s.step)).toEqual(['subscription_cancelled']);
      expect(due[0].anchorAt).toEqual(PERIOD_END);
    });

    it.each([
      [7 * DAY, 'subscription_followup_7d'],
      [30 * DAY, 'subscription_followup_30d'],
    ] as const)('emits S10 at grace end + %i ms and not earlier', (offset, step) => {
      const expired = input({
        status: 'expired',
        currentPeriodEnd: PERIOD_END,
        graceEndsAt: GRACE_END,
      });
      const dueAt = new Date(GRACE_END.getTime() + offset);
      expect(stepsAt(expired, justBefore(dueAt))).not.toContain(step);
      expect(stepsAt(expired, dueAt)).toContain(step);
    });

    it('sends no S10 to someone who cancelled — they told us why they left', () => {
      const cancelledThenExpired = input(
        { status: 'expired', currentPeriodEnd: PERIOD_END, graceEndsAt: GRACE_END },
        { paidCancelledAt: PERIOD_END },
      );
      expect(
        stepsAt(cancelledThenExpired, new Date(GRACE_END.getTime() + 7 * DAY)),
      ).toEqual([]);
    });

    it('stops the paid sequence instantly on a renewal', () => {
      const renewed = input({
        status: 'active',
        currentPeriodEnd: new Date(GRACE_END.getTime() + 40 * DAY),
        graceEndsAt: null,
      });
      expect(stepsAt(renewed, new Date(GRACE_END.getTime() + 7 * DAY))).toEqual([]);
      expect(stepsAt(renewed, new Date(GRACE_END.getTime() + 30 * DAY))).toEqual([]);
    });
  });

  describe('a whole sequence, walked at the real sweep cadence', () => {
    /**
     * Ticks the evaluator every 15 minutes — the real
     * `SUBSCRIPTION_SWEEP_INTERVAL_MS` — across a whole lifecycle, and
     * records the first tick at which each step becomes due.
     *
     * This is the closest a pure test gets to the production loop, and it
     * pins the two properties §26/§27 actually depend on: the steps arrive
     * in the plan's order, and NO TICK EVER YIELDS TWO STEPS. The second
     * is what makes "S5 then S7, never the reverse" a consequence of the
     * conditions rather than of a sort — the ordering in
     * `evaluateLifecycleSteps` is defence, not the mechanism.
     */
    function walk(
      evaluation: LifecycleEvaluationInput,
      from: Date,
      to: Date,
    ): { order: LifecycleStepId[]; maxPerTick: number } {
      const order: LifecycleStepId[] = [];
      const seen = new Set<LifecycleStepId>();
      let maxPerTick = 0;
      for (let t = from.getTime(); t <= to.getTime(); t += TICK) {
        const due = evaluateLifecycleSteps(evaluation, new Date(t));
        maxPerTick = Math.max(maxPerTick, due.length);
        for (const step of due) {
          if (!seen.has(step.step)) {
            seen.add(step.step);
            order.push(step.step);
          }
        }
      }
      return { order, maxPerTick };
    }

    it('walks a trial that is never converted through T2 → T3 → T4 → T5 → T6 and nothing else', () => {
      const trial = input({ status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT });
      const { order, maxPerTick } = walk(
        trial,
        new Date(TRIAL_ENDS_AT.getTime() - 3 * DAY),
        new Date(TRIAL_ENDS_AT.getTime() + 60 * DAY),
      );
      // T2 is absent because this row is already past its trial at every
      // tick; the trialing half of the walk is covered below.
      expect(order).toEqual([
        'trial_expired',
        'trial_followup_3d',
        'trial_followup_14d',
        'trial_reactivation_45d',
      ]);
      expect(maxPerTick).toBe(1);
    });

    it('walks a live trial into expiry: T2 arrives once, and never on the same tick as T3', () => {
      const live = input({ status: 'trialing', trialEndsAt: TRIAL_ENDS_AT });
      const { order, maxPerTick } = walk(
        live,
        new Date(TRIAL_ENDS_AT.getTime() - 3 * DAY),
        new Date(TRIAL_ENDS_AT.getTime() + DAY),
      );
      expect(order).toEqual(['trial_ending_soon', 'trial_expired']);
      expect(maxPerTick).toBe(1);
    });

    it('walks a paid period that is never renewed through S3 → S4 → S5 → S6 → S7 → S10', () => {
      // The row is left as the sweep found it (`active`), so every
      // transition below is DERIVED from the clock — the strongest form
      // of the claim, because it holds even if the sweep never ran.
      const paid = input({ status: 'active', currentPeriodEnd: PERIOD_END });
      const { order, maxPerTick } = walk(
        paid,
        new Date(PERIOD_END.getTime() - 10 * DAY),
        new Date(GRACE_END.getTime() + 40 * DAY),
      );
      expect(order).toEqual([
        'subscription_renewal_due',
        'subscription_renewal_tomorrow',
        'subscription_grace_started',
        'subscription_grace_ending',
        'subscription_expired',
        'subscription_followup_7d',
        'subscription_followup_30d',
      ]);
      expect(maxPerTick).toBe(1);
    });

    it('never puts anything clock-derived in the anchor — the same step at two instants anchors identically', () => {
      const lapsed = input({ status: 'trial_expired', trialEndsAt: TRIAL_ENDS_AT });
      const first = evaluateLifecycleSteps(lapsed, TRIAL_ENDS_AT)[0];
      const later = evaluateLifecycleSteps(
        lapsed,
        new Date(TRIAL_ENDS_AT.getTime() + 6 * HOUR),
      )[0];
      expect(first.step).toBe(later.step);
      expect(first.anchorAt.toISOString()).toBe(later.anchorAt.toISOString());
    });
  });

  describe('resolveLifecyclePhase', () => {
    it('separates a cancelled TRIAL from a cancelled PAID subscription by the cancellation record', () => {
      const trial = resolveLifecyclePhase(
        input(
          { status: 'cancelled', trialEndsAt: TRIAL_ENDS_AT },
          { trialCancelledAt: TRIAL_ENDS_AT },
        ),
        TRIAL_ENDS_AT,
      );
      expect(trial).toEqual({
        phase: 'trial_sequence',
        origin: 'trial',
        anchorAt: TRIAL_ENDS_AT,
      });

      const paid = resolveLifecyclePhase(
        input(
          { status: 'cancelled', currentPeriodEnd: PERIOD_END },
          { paidCancelledAt: PERIOD_END },
        ),
        PERIOD_END,
      );
      expect(paid).toEqual({
        phase: 'paid_sequence',
        origin: 'paid',
        anchorAt: PERIOD_END,
      });
    });

    it('reports a healthy tenant as `active` with no anchor', () => {
      expect(
        resolveLifecyclePhase(
          input({ status: 'active', currentPeriodEnd: PERIOD_END }),
          new Date(PERIOD_END.getTime() - 10 * DAY),
        ),
      ).toEqual({ phase: 'active', origin: null, anchorAt: null });
    });
  });
});
