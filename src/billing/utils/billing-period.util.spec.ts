import {
  addBillingPeriod,
  addCalendarMonthsUtc,
  computePurchaseDates,
  giftedDaysForCycle,
  resolvePurchaseBillingCycle,
} from './billing-period.util';

const utc = (iso: string): Date => new Date(iso);

describe('billing-period util (W8)', () => {
  describe('D3 — end-of-month clamp instead of setMonth overflow', () => {
    it('31 Jan + 1 month is 28 Feb in a common year (not 3 Mar)', () => {
      expect(
        addBillingPeriod(utc('2027-01-31T10:15:00.000Z'), 'monthly').toISOString(),
      ).toBe('2027-02-28T10:15:00.000Z');
    });

    it('31 Jan + 1 month is 29 Feb in a leap year', () => {
      expect(
        addBillingPeriod(utc('2028-01-31T00:00:00.000Z'), 'monthly').toISOString(),
      ).toBe('2028-02-29T00:00:00.000Z');
    });

    it('31 Mar + 1 month is 30 Apr; 30 Apr + 1 month is 30 May', () => {
      expect(addCalendarMonthsUtc(utc('2026-03-31T23:59:59.999Z'), 1).toISOString()).toBe(
        '2026-04-30T23:59:59.999Z',
      );
      expect(addCalendarMonthsUtc(utc('2026-04-30T12:00:00.000Z'), 1).toISOString()).toBe(
        '2026-05-30T12:00:00.000Z',
      );
    });

    it('rolls the year over in December', () => {
      expect(addCalendarMonthsUtc(utc('2026-12-31T08:00:00.000Z'), 1).toISOString()).toBe(
        '2027-01-31T08:00:00.000Z',
      );
    });

    it('29 Feb + 1 year is 28 Feb (not 1 Mar)', () => {
      expect(
        addBillingPeriod(utc('2028-02-29T06:00:00.000Z'), 'yearly').toISOString(),
      ).toBe('2029-02-28T06:00:00.000Z');
    });

    it('is independent of the process time zone (pure UTC arithmetic)', () => {
      // 1 Mar 00:30 UTC is still 28 Feb in America/*; local setMonth would
      // have computed from the wrong calendar day.
      expect(
        addBillingPeriod(utc('2027-03-01T00:30:00.000Z'), 'monthly').toISOString(),
      ).toBe('2027-04-01T00:30:00.000Z');
    });
  });

  describe('D4 — billing cycle resolution', () => {
    it('prefers the checkout column', () => {
      expect(resolvePurchaseBillingCycle('monthly', { billingCycle: 'yearly' })).toBe(
        'monthly',
      );
    });

    it('falls back to the frozen snapshot when the column is NULL (yearly is not treated as monthly)', () => {
      expect(resolvePurchaseBillingCycle(null, { billingCycle: 'yearly' })).toBe(
        'yearly',
      );
    });

    it('defaults to monthly when neither carries a cycle', () => {
      expect(resolvePurchaseBillingCycle(null, {})).toBe('monthly');
      expect(resolvePurchaseBillingCycle(undefined, null)).toBe('monthly');
      expect(resolvePurchaseBillingCycle(null, { billingCycle: 'weekly' })).toBe(
        'monthly',
      );
    });
  });

  describe('gifted days configuration', () => {
    const plan = { giftedDaysMonthly: 7, giftedDaysYearly: 14 };

    it('picks the value for the resolved cycle', () => {
      expect(giftedDaysForCycle(plan, 'monthly')).toBe(7);
      expect(giftedDaysForCycle(plan, 'yearly')).toBe(14);
    });

    it('treats NULL, 0 and out-of-range values as no gift', () => {
      expect(
        giftedDaysForCycle(
          { giftedDaysMonthly: null, giftedDaysYearly: null },
          'monthly',
        ),
      ).toBeNull();
      expect(
        giftedDaysForCycle({ giftedDaysMonthly: 0, giftedDaysYearly: 0 }, 'yearly'),
      ).toBeNull();
      expect(
        giftedDaysForCycle({ giftedDaysMonthly: 4, giftedDaysYearly: 16 }, 'monthly'),
      ).toBeNull();
      expect(
        giftedDaysForCycle({ giftedDaysMonthly: 4, giftedDaysYearly: 16 }, 'yearly'),
      ).toBeNull();
    });
  });

  describe('purchase dates', () => {
    it('gift: [approval, approval + N x 24h) then one FULL paid period from the gift end', () => {
      const approvedAt = utc('2027-01-24T09:00:00.000Z');
      const dates = computePurchaseDates({
        periodStart: approvedAt,
        billingCycle: 'monthly',
        giftedDays: 7,
      });
      expect(dates.gift).toEqual({
        days: 7,
        startsAt: approvedAt,
        endsAt: utc('2027-01-31T09:00:00.000Z'),
      });
      expect(dates.currentPeriodStart.toISOString()).toBe('2027-01-31T09:00:00.000Z');
      // The paid month that starts on the 31st is clamped, not overflowed.
      expect(dates.currentPeriodEnd.toISOString()).toBe('2027-02-28T09:00:00.000Z');
    });

    it('yearly gift of 14 days', () => {
      const dates = computePurchaseDates({
        periodStart: utc('2026-11-04T00:00:00.000Z'),
        billingCycle: 'yearly',
        giftedDays: 14,
      });
      expect(dates.currentPeriodStart.toISOString()).toBe('2026-11-18T00:00:00.000Z');
      expect(dates.currentPeriodEnd.toISOString()).toBe('2027-11-18T00:00:00.000Z');
    });

    it('no gift: the paid period starts at the period start', () => {
      const start = utc('2026-11-04T00:00:00.000Z');
      const dates = computePurchaseDates({
        periodStart: start,
        billingCycle: 'monthly',
        giftedDays: null,
      });
      expect(dates.gift).toBeNull();
      expect(dates.currentPeriodStart).toEqual(start);
      expect(dates.currentPeriodEnd.toISOString()).toBe('2026-12-04T00:00:00.000Z');
    });
  });
});
