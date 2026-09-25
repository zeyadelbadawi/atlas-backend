/**
 * The retention evaluator, boundary by boundary — P64 Communications C6.
 *
 * This is the file that decides whether a paying customer's video is
 * destroyed, so it is pinned here without a database: `now` is an
 * argument, so every assertion can stand exactly on, 1 ms before and
 * 1 ms after each boundary, and the whole 180-day paid sequence runs in
 * microseconds.
 *
 * The three guards of the evaluator's own header each get a group, and
 * each group contains at least one test that FAILS if the guard is
 * removed — which is how the guards were actually verified (see the
 * workstream report).
 */
import {
  evaluateRetentionSteps,
  isWithinRetentionWindow,
  resolveRetentionWindow,
  retentionCandidateAnchorRange,
  RETENTION_DELETION_MAX_LATENESS_MS,
  RETENTION_SHORT_NOTICE_LATENESS_MS,
  RETENTION_STEP_MAX_LATENESS_MS,
  RETENTION_W1_LEAD_MS,
  RETENTION_W2_LEAD_MS,
  RETENTION_W3_LEAD_MS,
  RETENTION_W4_LEAD_MS,
  RETENTION_WARNING_STEPS,
  RETENTION_WINDOW_PAID_MS,
  RETENTION_WINDOW_TRIAL_MS,
  type RetentionEvaluationInput,
  type RetentionStepId,
} from './video-retention.util';

const DAY = 24 * 60 * 60 * 1000;
const TRIAL_ENDED = new Date('2026-10-01T09:00:00.000Z');
const GRACE_ENDED = new Date('2026-10-08T09:00:00.000Z');

const ALL_WARNINGS = new Set<RetentionStepId>(RETENTION_WARNING_STEPS);

function lapsedTrial(
  overrides: Partial<RetentionEvaluationInput> = {},
): RetentionEvaluationInput {
  return {
    subscription: {
      status: 'trial_expired',
      trialEndsAt: TRIAL_ENDED,
      currentPeriodEnd: null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
    },
    trialCancelledAt: null,
    paidCancelledAt: null,
    held: false,
    warningsAlreadySent: new Set(),
    ...overrides,
  };
}

function lapsedPaid(
  overrides: Partial<RetentionEvaluationInput> = {},
): RetentionEvaluationInput {
  return {
    subscription: {
      status: 'expired',
      trialEndsAt: null,
      currentPeriodEnd: new Date(GRACE_ENDED.getTime() - 7 * DAY),
      graceEndsAt: GRACE_ENDED,
      cancelAtPeriodEnd: false,
    },
    trialCancelledAt: null,
    paidCancelledAt: null,
    held: false,
    warningsAlreadySent: new Set(),
    ...overrides,
  };
}

const stepsAt = (input: RetentionEvaluationInput, now: Date): RetentionStepId[] =>
  evaluateRetentionSteps(input, now).map((step) => step.step);

describe('retention windows (§31)', () => {
  it('gives a formerly-trialing tenant 90 days from the trial end', () => {
    const window = resolveRetentionWindow(lapsedTrial(), TRIAL_ENDED);
    expect(window).not.toBeNull();
    expect(window!.origin).toBe('trial');
    expect(window!.anchorAt).toEqual(TRIAL_ENDED);
    expect(window!.deletionAt.getTime()).toBe(
      TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS,
    );
  });

  it('gives a formerly-paid tenant 180 days from the grace end', () => {
    const window = resolveRetentionWindow(lapsedPaid(), GRACE_ENDED);
    expect(window!.origin).toBe('paid');
    expect(window!.deletionAt.getTime()).toBe(
      GRACE_ENDED.getTime() + RETENTION_WINDOW_PAID_MS,
    );
  });

  /**
   * §31: "a paid cancellation keeps the 180-day window; a trial
   * cancellation the 90-day one". Both write the same `cancelled` status,
   * so the cancellation KIND is the only fact separating them — getting
   * this wrong deletes a paying customer's video three months early.
   */
  it('separates a cancelled trial from a cancelled paid subscription by kind', () => {
    const cancelledTrial = lapsedTrial({
      subscription: {
        status: 'cancelled',
        trialEndsAt: TRIAL_ENDED,
        currentPeriodEnd: null,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
      },
      trialCancelledAt: TRIAL_ENDED,
    });
    const cancelledPaid = lapsedPaid({
      subscription: {
        status: 'cancelled',
        trialEndsAt: null,
        currentPeriodEnd: GRACE_ENDED,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
      },
      paidCancelledAt: GRACE_ENDED,
    });
    expect(
      resolveRetentionWindow(cancelledTrial, TRIAL_ENDED)!.deletionAt.getTime(),
    ).toBe(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);
    expect(resolveRetentionWindow(cancelledPaid, GRACE_ENDED)!.deletionAt.getTime()).toBe(
      GRACE_ENDED.getTime() + RETENTION_WINDOW_PAID_MS,
    );
  });

  it('has no window at all for an active or trialing tenant', () => {
    const active = lapsedTrial({
      subscription: {
        status: 'active',
        trialEndsAt: TRIAL_ENDED,
        currentPeriodEnd: new Date('2027-10-01T09:00:00.000Z'),
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
      },
    });
    expect(
      resolveRetentionWindow(active, new Date('2026-12-01T00:00:00.000Z')),
    ).toBeNull();
    expect(stepsAt(active, new Date('2026-12-01T00:00:00.000Z'))).toEqual([]);
  });

  /** §32's own worked example, reproduced exactly. */
  it('reproduces §32: trial ended 1 Oct -> W1 30 Nov, deletion 30 Dec', () => {
    const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);
    const w1 = new Date(deletionAt.getTime() - RETENTION_W1_LEAD_MS);
    expect(deletionAt.toISOString().slice(0, 10)).toBe('2026-12-30');
    expect(w1.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(
      new Date(deletionAt.getTime() - RETENTION_W2_LEAD_MS).toISOString().slice(0, 10),
    ).toBe('2026-12-16');
    expect(
      new Date(deletionAt.getTime() - RETENTION_W3_LEAD_MS).toISOString().slice(0, 10),
    ).toBe('2026-12-23');
    expect(
      new Date(deletionAt.getTime() - RETENTION_W4_LEAD_MS).toISOString().slice(0, 10),
    ).toBe('2026-12-29');
  });
});

describe('each warning fires at its own boundary and not before', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);
  const cases: ReadonlyArray<[RetentionStepId, number]> = [
    ['retention_warning_30d', RETENTION_W1_LEAD_MS],
    ['retention_warning_14d', RETENTION_W2_LEAD_MS],
    ['retention_warning_7d', RETENTION_W3_LEAD_MS],
    ['retention_warning_24h', RETENTION_W4_LEAD_MS],
  ];

  it.each(cases)('%s is not due 1 ms early and is due exactly on time', (step, lead) => {
    const dueAt = new Date(deletionAt.getTime() - lead);
    expect(stepsAt(lapsedTrial(), new Date(dueAt.getTime() - 1))).not.toContain(step);
    expect(stepsAt(lapsedTrial(), dueAt)).toContain(step);
  });
});

describe('guard (1) — the lateness horizon', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);
  const w1DueAt = new Date(deletionAt.getTime() - RETENTION_W1_LEAD_MS);

  it('still emits W1 on the last millisecond of its horizon', () => {
    const at = new Date(w1DueAt.getTime() + RETENTION_STEP_MAX_LATENESS_MS);
    expect(stepsAt(lapsedTrial(), at)).toContain('retention_warning_30d');
  });

  it('refuses W1 one millisecond past its horizon', () => {
    const at = new Date(w1DueAt.getTime() + RETENTION_STEP_MAX_LATENESS_MS + 1);
    expect(stepsAt(lapsedTrial(), at)).not.toContain('retention_warning_30d');
  });

  it('holds W4 to the shorter six-hour horizon, because "tomorrow" stops being true', () => {
    const dueAt = new Date(deletionAt.getTime() - RETENTION_W4_LEAD_MS);
    expect(
      stepsAt(
        lapsedTrial(),
        new Date(dueAt.getTime() + RETENTION_SHORT_NOTICE_LATENESS_MS),
      ),
    ).toContain('retention_warning_24h');
    expect(
      stepsAt(
        lapsedTrial(),
        new Date(dueAt.getTime() + RETENTION_SHORT_NOTICE_LATENESS_MS + 1),
      ),
    ).not.toContain('retention_warning_24h');
  });

  it('still deletes on the last millisecond of the deletion horizon', () => {
    const at = new Date(deletionAt.getTime() + RETENTION_DELETION_MAX_LATENESS_MS);
    expect(stepsAt(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }), at)).toContain(
      'retention_delete',
    );
  });

  /**
   * THE TEST THIS WHOLE WORKSTREAM EXISTS FOR.
   *
   * Production is roughly sixteen of seventeen organisations sitting in
   * `trial_expired`, most of them lapsed months ago. `trial_expired` is
   * terminal: it is true forever. Without the horizon, the first tick
   * after someone sets the flag to `on` finds every one of them past
   * every warning AND past its deletion date simultaneously, and deletes
   * all of their video in one tick.
   *
   * Remove `isWithinRetentionWindow` from the deletion branch and this
   * test fails with `retention_delete` in the list.
   */
  it('never warns or deletes a tenant who lapsed long before the feature existed', () => {
    const lapsedTwoYearsAgo = new Date(TRIAL_ENDED.getTime() + 2 * 365 * DAY);
    expect(
      stepsAt(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }), lapsedTwoYearsAgo),
    ).toEqual([]);
  });

  it('is the same for a long-lapsed paid tenant', () => {
    const lapsedTwoYearsAgo = new Date(GRACE_ENDED.getTime() + 2 * 365 * DAY);
    expect(
      stepsAt(lapsedPaid({ warningsAlreadySent: ALL_WARNINGS }), lapsedTwoYearsAgo),
    ).toEqual([]);
  });

  it('bounds the candidate query by the same constants the decision uses', () => {
    const now = new Date('2027-01-15T00:00:00.000Z');
    const range = retentionCandidateAnchorRange('trial', now);
    // An anchor at the oldest end is exactly at its deletion horizon...
    expect(
      isWithinRetentionWindow(
        'retention_delete',
        new Date(range.earliest.getTime() + RETENTION_WINDOW_TRIAL_MS),
        now,
      ),
    ).toBe(true);
    // ...and one millisecond older is not fetched AND would not be due.
    expect(
      isWithinRetentionWindow(
        'retention_delete',
        new Date(range.earliest.getTime() - 1 + RETENTION_WINDOW_TRIAL_MS),
        now,
      ),
    ).toBe(false);
    // The newest candidate is the one whose W1 has just fallen due.
    expect(range.latest.getTime()).toBe(
      now.getTime() - (RETENTION_WINDOW_TRIAL_MS - RETENTION_W1_LEAD_MS),
    );
  });
});

describe('guard (2) — nothing is deleted that was not warned four times', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);

  it('withholds the deletion when no warning was ever sent', () => {
    expect(stepsAt(lapsedTrial(), deletionAt)).not.toContain('retention_delete');
  });

  it.each(RETENTION_WARNING_STEPS)(
    'withholds the deletion when only %s is missing',
    (missing) => {
      const partial = new Set(RETENTION_WARNING_STEPS.filter((step) => step !== missing));
      expect(
        stepsAt(lapsedTrial({ warningsAlreadySent: partial }), deletionAt),
      ).not.toContain('retention_delete');
    },
  );

  it('permits the deletion once all four are present', () => {
    expect(
      stepsAt(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }), deletionAt),
    ).toContain('retention_delete');
  });

  /**
   * The guard that makes enabling this feature safe on day one, quite
   * apart from the horizon: on the first `on` tick nobody has been warned
   * yet, so nobody is deletable — whatever their dates say.
   */
  it('makes the first tick after enabling harmless even inside the horizon', () => {
    const justPastTheDate = new Date(deletionAt.getTime() + DAY);
    expect(stepsAt(lapsedTrial(), justPastTheDate)).not.toContain('retention_delete');
  });
});

describe('guard (3) — a hold freezes everything', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);

  it('suppresses the deletion even when every other condition is met', () => {
    expect(
      stepsAt(lapsedTrial({ held: true, warningsAlreadySent: ALL_WARNINGS }), deletionAt),
    ).toEqual([]);
  });

  it('suppresses the warnings too, not only the deletion', () => {
    const w1DueAt = new Date(deletionAt.getTime() - RETENTION_W1_LEAD_MS);
    expect(stepsAt(lapsedTrial(), w1DueAt)).toContain('retention_warning_30d');
    expect(stepsAt(lapsedTrial({ held: true }), w1DueAt)).toEqual([]);
  });

  /**
   * The interaction that matters. A hold does not rewind the clock (that
   * would need a column recording accumulated held time, which does not
   * exist). What stops a long hold from "releasing into" a mass deletion
   * is guard (1): every step it covered has aged out of its own window.
   */
  it('releases quietly rather than explosively after a long hold', () => {
    const releasedLate = new Date(
      deletionAt.getTime() + RETENTION_DELETION_MAX_LATENESS_MS + DAY,
    );
    expect(
      stepsAt(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }), releasedLate),
    ).toEqual([]);
  });
});

describe('reactivation stops the sequence at every stage', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);
  const reactivated = (): RetentionEvaluationInput =>
    lapsedTrial({
      subscription: {
        status: 'active',
        trialEndsAt: TRIAL_ENDED,
        currentPeriodEnd: new Date(deletionAt.getTime() + 365 * DAY),
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
      },
      warningsAlreadySent: ALL_WARNINGS,
    });

  it.each([
    ['at W1', RETENTION_W1_LEAD_MS],
    ['at W2', RETENTION_W2_LEAD_MS],
    ['at W3', RETENTION_W3_LEAD_MS],
    ['at W4', RETENTION_W4_LEAD_MS],
    ['on the deletion day', 0],
  ])('%s, nothing further is due', (_label, lead) => {
    const at = new Date(deletionAt.getTime() - lead);
    expect(stepsAt(reactivated(), at)).toEqual([]);
  });
});

describe('the shape of the whole sequence, walked hour by hour', () => {
  const deletionAt = new Date(TRIAL_ENDED.getTime() + RETENTION_WINDOW_TRIAL_MS);

  /**
   * Walks the entire 90-day window at one-hour resolution and records
   * every step the evaluator hands out.
   *
   * Cheap (about 2,300 pure calls) and worth far more than spot checks:
   * it proves properties about the sequence AS A WHOLE rather than at the
   * boundaries somebody thought to name.
   */
  function walk(input: RetentionEvaluationInput) {
    const seen: Array<{ step: RetentionStepId; at: number }> = [];
    let maxConcurrent = 0;
    const from = TRIAL_ENDED.getTime();
    const to = deletionAt.getTime() + RETENTION_DELETION_MAX_LATENESS_MS + 2 * DAY;
    for (let at = from; at <= to; at += 60 * 60 * 1000) {
      const due = evaluateRetentionSteps(input, new Date(at));
      maxConcurrent = Math.max(maxConcurrent, due.length);
      for (let i = 1; i < due.length; i++) {
        expect(due[i].dueAt.getTime()).toBeGreaterThanOrEqual(due[i - 1].dueAt.getTime());
      }
      for (const step of due) {
        expect(step.anchorAt).toEqual(TRIAL_ENDED);
        expect(step.deletionAt).toEqual(deletionAt);
        if (!seen.some((entry) => entry.step === step.step)) {
          seen.push({ step: step.step, at });
        }
      }
    }
    return { seen, maxConcurrent };
  }

  it('hands out W1, W2, W3, W4 and then the deletion, in that order and once each', () => {
    const { seen } = walk(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }));
    expect(seen.map((entry) => entry.step)).toEqual([
      'retention_warning_30d',
      'retention_warning_14d',
      'retention_warning_7d',
      'retention_warning_24h',
      'retention_delete',
    ]);
  });

  /**
   * A consequence of the leads and the horizons together, asserted
   * because it is load-bearing rather than incidental: the destructive
   * step can never share a tick with a warning, so "emit the warnings
   * first" is never a thing the sweep has to get right under pressure.
   */
  it('never has two steps due on the same tick', () => {
    expect(walk(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS })).maxConcurrent).toBe(
      1,
    );
  });

  it('carries the same anchor and deletion date on every step it ever emits', () => {
    // Asserted inside `walk` for all ~2,300 instants; this case exists so
    // the claim is named where a reader looks for it.
    const { seen } = walk(lapsedTrial({ warningsAlreadySent: ALL_WARNINGS }));
    expect(seen).toHaveLength(5);
  });

  it('walks the same sequence to four warnings and NO deletion when unwarned', () => {
    const { seen } = walk(lapsedTrial());
    expect(seen.map((entry) => entry.step)).toEqual([
      'retention_warning_30d',
      'retention_warning_14d',
      'retention_warning_7d',
      'retention_warning_24h',
    ]);
  });
});
