import {
  catalogAnnualPrice,
  expectedPurchasePeriodStart,
  foundingPriceFor,
  lockEndFor,
  type FoundingLock,
} from './founding-lock';
import { cairoWeekStart, csvCell } from './services/founding-memberships.service';

const START = new Date('2026-11-01T10:00:00.000Z');
const LOCK: FoundingLock = {
  id: 'm1',
  seatNumber: 1,
  planId: 'growth-id',
  lockedAmount: 27900,
  lockedCurrency: 'EGP',
  lockStartsAt: START,
  lockEndsAt: lockEndFor(START),
  status: 'active',
};

describe('founding lock pricing (B2)', () => {
  it('ends the lock 24 calendar months after it starts', () => {
    expect(lockEndFor(START).toISOString()).toBe('2028-11-01T10:00:00.000Z');
    expect(lockEndFor(new Date('2028-02-29T00:00:00.000Z')).toISOString()).toBe(
      '2030-02-28T00:00:00.000Z',
    );
  });

  it('prices the first year and the renewal a year later at the locked price', () => {
    const purchase = { planId: 'growth-id', billingCycle: 'yearly' as const };
    expect(foundingPriceFor(LOCK, { ...purchase, periodStart: START })).toEqual({
      amount: 27900,
      currency: 'EGP',
    });
    expect(
      foundingPriceFor(LOCK, {
        ...purchase,
        periodStart: new Date('2027-11-01T10:00:00.000Z'),
      }),
    ).toEqual({ amount: 27900, currency: 'EGP' });
  });

  it('returns to the catalog for a renewal starting at or after the lock end', () => {
    const purchase = { planId: 'growth-id', billingCycle: 'yearly' as const };
    expect(
      foundingPriceFor(LOCK, { ...purchase, periodStart: LOCK.lockEndsAt }),
    ).toBeNull();
    expect(
      foundingPriceFor(LOCK, {
        ...purchase,
        periodStart: new Date('2029-01-01T00:00:00.000Z'),
      }),
    ).toBeNull();
  });

  it('never applies to another plan, a monthly purchase, or a revoked/ended membership', () => {
    const base = {
      planId: 'growth-id',
      billingCycle: 'yearly' as const,
      periodStart: START,
    };
    expect(foundingPriceFor(LOCK, { ...base, planId: 'starter-id' })).toBeNull();
    expect(foundingPriceFor(LOCK, { ...base, billingCycle: 'monthly' })).toBeNull();
    expect(foundingPriceFor(LOCK, { ...base, billingCycle: null })).toBeNull();
    expect(foundingPriceFor({ ...LOCK, status: 'revoked' }, base)).toBeNull();
    expect(foundingPriceFor({ ...LOCK, status: 'ended' }, base)).toBeNull();
    expect(foundingPriceFor(null, base)).toBeNull();
  });

  it('starts a renewal at the end of a live period, otherwise now (as payment application does)', () => {
    const now = new Date('2027-10-20T00:00:00.000Z');
    const end = new Date('2027-11-01T10:00:00.000Z');
    expect(
      expectedPurchasePeriodStart({ status: 'active', currentPeriodEnd: end }, now),
    ).toBe(end);
    expect(
      expectedPurchasePeriodStart({ status: 'grace_period', currentPeriodEnd: end }, now),
    ).toBe(end);
    expect(
      expectedPurchasePeriodStart({ status: 'expired', currentPeriodEnd: end }, now),
    ).toBe(now);
    expect(
      expectedPurchasePeriodStart(
        { status: 'active', currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z') },
        now,
      ),
    ).toBe(now);
    expect(expectedPurchasePeriodStart(null, now)).toBe(now);
  });

  it('reads the annual catalog price the way a yearly checkout charges it', () => {
    expect(
      catalogAnnualPrice({
        amount: 2790,
        currency: 'EGP',
        billingCycle: 'monthly',
        yearlyAmount: 27900,
      }),
    ).toEqual({ amount: 27900, currency: 'EGP' });
    expect(
      catalogAnnualPrice({ amount: 2790, currency: 'EGP', billingCycle: 'monthly' }),
    ).toBeNull();
    expect(
      catalogAnnualPrice({ amount: 30000, currency: 'EGP', billingCycle: 'yearly' }),
    ).toEqual({
      amount: 30000,
      currency: 'EGP',
    });
    expect(catalogAnnualPrice(null)).toBeNull();
  });
});

describe('founding helpers', () => {
  it('neutralises spreadsheet formulas and quotes every CSV cell', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+20 100')).toBe(`"'+20 100"`);
    expect(csvCell('Nour, "Academy"')).toBe('"Nour, ""Academy"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
  });

  it('starts the week on Monday 00:00 in Cairo', () => {
    // Wednesday 2026-10-21 15:00 Cairo (UTC+3 in DST) → Monday 2026-10-19 00:00 Cairo.
    const start = cairoWeekStart(new Date('2026-10-21T12:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-10-18T21:00:00.000Z');
    // Monday 00:30 Cairo is in the same week it starts.
    expect(cairoWeekStart(new Date('2026-10-18T21:30:00.000Z')).toISOString()).toBe(
      '2026-10-18T21:00:00.000Z',
    );
  });
});
