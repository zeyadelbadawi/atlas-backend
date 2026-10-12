import {
  buildPriceChangeNotice,
  formatNoticePrice,
  readPriceChangeNotice,
  renewalCycleFor,
  renewalPriceFor,
} from './price-change-notice.util';
import type { BuildPriceChangeNoticeInput } from './price-change-notice.util';

const monthly = (amount: number, yearlyAmount?: number) => ({
  amount,
  currency: 'EGP',
  billingCycle: 'monthly',
  ...(yearlyAmount !== undefined ? { yearlyAmount } : {}),
});

const limits = { academies: 1, students: 100, courses: 20 };
const at = new Date('2026-11-01T10:00:00.000Z');

function input(over: Partial<BuildPriceChangeNoticeInput>): BuildPriceChangeNoticeInput {
  return {
    planId: 'plan-1',
    planVersion: 2,
    billingCycle: 'monthly',
    previousPricing: monthly(1190),
    nextPricing: monthly(1190),
    currentLimits: limits,
    nextLimits: limits,
    pending: null,
    noticedAt: at,
    ...over,
  };
}

describe('renewalPriceFor', () => {
  it('uses the monthly amount for a monthly renewal', () => {
    expect(renewalPriceFor(monthly(1190, 11900), 'monthly')).toEqual({
      amount: 1190,
      currency: 'EGP',
    });
  });

  it('uses yearlyAmount for a yearly renewal of a monthly plan', () => {
    expect(renewalPriceFor(monthly(1190, 11900), 'yearly')).toEqual({
      amount: 11900,
      currency: 'EGP',
    });
  });

  it('returns null when the plan has no price for that cycle', () => {
    expect(renewalPriceFor(monthly(1190), 'yearly')).toBeNull();
    expect(renewalPriceFor(null, 'monthly')).toBeNull();
    expect(renewalPriceFor({ amount: 5 }, 'monthly')).toBeNull();
  });

  it('treats a plan with no cycle as cycle-agnostic', () => {
    expect(renewalPriceFor({ amount: 15, currency: 'USD' }, 'yearly')).toEqual({
      amount: 15,
      currency: 'USD',
    });
  });
});

describe('renewalCycleFor', () => {
  it("prefers the subscription's own cycle, then the plan's, then monthly", () => {
    expect(renewalCycleFor('yearly', monthly(1))).toBe('yearly');
    expect(renewalCycleFor(null, { billingCycle: 'yearly' })).toBe('yearly');
    expect(renewalCycleFor(undefined, null)).toBe('monthly');
  });
});

describe('buildPriceChangeNotice', () => {
  it('returns null when nothing the subscriber renews into changes', () => {
    expect(buildPriceChangeNotice(input({}))).toBeNull();
    // Only the yearly price moved; a monthly subscriber is not affected.
    expect(
      buildPriceChangeNotice(
        input({
          previousPricing: monthly(1190, 11900),
          nextPricing: monthly(1190, 9900),
        }),
      ),
    ).toBeNull();
  });

  it('records the old and new renewal price', () => {
    const notice = buildPriceChangeNotice(input({ nextPricing: monthly(1390) }));
    expect(notice).toEqual({
      planId: 'plan-1',
      planVersion: 2,
      billingCycle: 'monthly',
      fromPrice: { amount: 1190, currency: 'EGP' },
      toPrice: { amount: 1390, currency: 'EGP' },
      limitChanges: {},
      noticedAt: at.toISOString(),
    });
  });

  it('records every limit that differs from what the subscriber holds now', () => {
    const notice = buildPriceChangeNotice(
      input({ nextLimits: { academies: 1, students: 400, courses: 'unlimited' } }),
    );
    expect(notice?.limitChanges).toEqual({
      students: { from: 100, to: 400 },
      courses: { from: 20, to: 'unlimited' },
    });
  });

  it('keeps the first fromPrice while an earlier notice is still pending', () => {
    const first = buildPriceChangeNotice(input({ nextPricing: monthly(1300) }));
    const second = buildPriceChangeNotice(
      input({
        planVersion: 3,
        previousPricing: monthly(1300),
        nextPricing: monthly(1400),
        pending: first,
      }),
    );
    expect(second?.fromPrice).toEqual({ amount: 1190, currency: 'EGP' });
    expect(second?.toPrice).toEqual({ amount: 1400, currency: 'EGP' });
    expect(second?.planVersion).toBe(3);
  });

  it('returns null when a second edit puts the price back', () => {
    const first = buildPriceChangeNotice(input({ nextPricing: monthly(1300) }));
    expect(
      buildPriceChangeNotice(
        input({
          previousPricing: monthly(1300),
          nextPricing: monthly(1190),
          pending: first,
        }),
      ),
    ).toBeNull();
  });

  it('ignores a pending notice about a different plan', () => {
    const other = buildPriceChangeNotice(
      input({ planId: 'plan-2', nextPricing: monthly(1) }),
    );
    const notice = buildPriceChangeNotice(
      input({ nextPricing: monthly(1390), pending: other }),
    );
    expect(notice?.fromPrice).toEqual({ amount: 1190, currency: 'EGP' });
  });

  it('records a currency change as a price change', () => {
    const notice = buildPriceChangeNotice(
      input({
        previousPricing: { amount: 1190, currency: 'USD', billingCycle: 'monthly' },
      }),
    );
    expect(notice?.fromPrice?.currency).toBe('USD');
    expect(notice?.toPrice?.currency).toBe('EGP');
  });
});

describe('readPriceChangeNotice', () => {
  it('accepts a stored notice and rejects anything else', () => {
    const notice = buildPriceChangeNotice(input({ nextPricing: monthly(1390) }));
    expect(readPriceChangeNotice(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
    expect(readPriceChangeNotice(null)).toBeNull();
    expect(readPriceChangeNotice([])).toBeNull();
    expect(readPriceChangeNotice({ planId: 'x' })).toBeNull();
  });
});

describe('formatNoticePrice', () => {
  it('formats with a thousands separator and the currency code', () => {
    expect(formatNoticePrice({ amount: 11900, currency: 'EGP' })).toBe('11,900 EGP');
    expect(formatNoticePrice(null)).toBe('');
  });
});
