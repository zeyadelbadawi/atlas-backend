import { isRefusedMidAnnualPlanChange } from './annual-plan-change.util';

const NOW = new Date('2026-10-12T12:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const annual = (
  over: Partial<Parameters<typeof isRefusedMidAnnualPlanChange>[0]> = {},
) => ({
  status: 'active',
  billingCycle: 'yearly',
  currentPeriodEnd: days(200),
  planKey: 'teacher',
  ...over,
});

describe('isRefusedMidAnnualPlanChange', () => {
  it('refuses a different plan with more than 30 days of an annual period left', () => {
    expect(isRefusedMidAnnualPlanChange(annual(), 'academy', NOW)).toBe(true);
    expect(
      isRefusedMidAnnualPlanChange(annual({ status: 'grace_period' }), 'academy', NOW),
    ).toBe(true);
  });

  it('allows renewing the same plan', () => {
    expect(isRefusedMidAnnualPlanChange(annual(), 'teacher', NOW)).toBe(false);
  });

  it('allows a change in the last 30 days of the annual period', () => {
    expect(
      isRefusedMidAnnualPlanChange(
        annual({ currentPeriodEnd: days(30) }),
        'academy',
        NOW,
      ),
    ).toBe(false);
    expect(
      isRefusedMidAnnualPlanChange(annual({ currentPeriodEnd: days(5) }), 'academy', NOW),
    ).toBe(false);
  });

  it('allows changes on monthly subscriptions, trials, expired ones and first purchases', () => {
    expect(
      isRefusedMidAnnualPlanChange(annual({ billingCycle: 'monthly' }), 'academy', NOW),
    ).toBe(false);
    expect(
      isRefusedMidAnnualPlanChange(annual({ status: 'trialing' }), 'academy', NOW),
    ).toBe(false);
    expect(
      isRefusedMidAnnualPlanChange(annual({ status: 'expired' }), 'academy', NOW),
    ).toBe(false);
    expect(isRefusedMidAnnualPlanChange(null, 'academy', NOW)).toBe(false);
  });
});
