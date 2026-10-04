/**
 * PaymentApplicationService — W8 regressions (D2 idempotency, D3 month
 * clamp, D4 cycle resolution) and the gifted-days date mechanics.
 */
import { PaymentApplicationService } from './payment-application.service';

const NOW = new Date('2027-01-31T09:00:00.000Z');
const PLAN = {
  id: 'plan-1',
  key: 'growth',
  giftedDaysMonthly: 7,
  giftedDaysYearly: 14,
  limits: { academies: 1 },
};

function setup(opts: {
  transitioned?: boolean;
  existing?: Record<string, unknown> | null;
  checkout?: Record<string, unknown>;
  gift?: {
    granted: boolean;
    days?: number;
    startsAt?: Date;
    endsAt?: Date;
    reason?: string;
  };
}) {
  const payment = { id: 'pay-1', checkoutId: 'co-1' };
  const tx = {
    payment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...payment, status: 'succeeded' }),
    },
    checkout: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'co-1',
        organizationId: 'org-1',
        targetType: 'plan_subscription',
        targetKey: 'growth',
        billingCycle: 'monthly',
        snapshot: {},
        ...opts.checkout,
      }),
    },
  };
  const paymentsRepository = {
    markSucceededIfNotAlready: jest.fn().mockResolvedValue(opts.transitioned ?? true),
  };
  const checkoutsRepository = { updateStatus: jest.fn() };
  const plansRepository = { findByKey: jest.fn().mockResolvedValue(PLAN) };
  const tenantSubscriptionsRepository = {
    lockForPurchase: jest.fn(),
    findByOrganizationId: jest.fn().mockResolvedValue(opts.existing ?? null),
    upsertForPlanPurchase: jest.fn(),
  };
  const gift = {
    claimFirstPaidGift: jest
      .fn()
      .mockResolvedValue(opts.gift ?? { granted: false, reason: 'no_gift_configured' }),
  };
  const service = new PaymentApplicationService(
    checkoutsRepository as never,
    paymentsRepository as never,
    plansRepository as never,
    {} as never,
    tenantSubscriptionsRepository as never,
    {} as never,
    gift as never,
    { now: () => NOW },
  );
  return {
    service,
    tx,
    payment,
    paymentsRepository,
    tenantSubscriptionsRepository,
    gift,
    checkoutsRepository,
  };
}

describe('PaymentApplicationService.applySuccessfulPayment (W8)', () => {
  it('D2 — a payment that is already succeeded applies NO second period', async () => {
    const t = setup({ transitioned: false });
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    expect(t.checkoutsRepository.updateStatus).not.toHaveBeenCalled();
    expect(t.tenantSubscriptionsRepository.upsertForPlanPurchase).not.toHaveBeenCalled();
    expect(t.gift.claimFirstPaidGift).not.toHaveBeenCalled();
  });

  it('serialises purchases per organization before reading the subscription', async () => {
    const t = setup({});
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    const lockOrder =
      t.tenantSubscriptionsRepository.lockForPurchase.mock.invocationCallOrder[0];
    const readOrder =
      t.tenantSubscriptionsRepository.findByOrganizationId.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('D3 — a monthly purchase on 31 Jan ends 28 Feb (clamped), not 3 Mar', async () => {
    const t = setup({});
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    const data = t.tenantSubscriptionsRepository.upsertForPlanPurchase.mock.calls[0][2];
    expect(data.currentPeriodStart).toEqual(NOW);
    expect(data.currentPeriodEnd.toISOString()).toBe('2027-02-28T09:00:00.000Z');
    expect(data.gift).toBeUndefined();
  });

  it('D4 — a NULL checkout cycle with a yearly snapshot is applied as YEARLY', async () => {
    const t = setup({
      checkout: { billingCycle: null, snapshot: { billingCycle: 'yearly' } },
    });
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    const data = t.tenantSubscriptionsRepository.upsertForPlanPurchase.mock.calls[0][2];
    expect(data.billingCycle).toBe('yearly');
    expect(data.currentPeriodEnd.toISOString()).toBe('2028-01-31T09:00:00.000Z');
    expect(t.gift.claimFirstPaidGift.mock.calls[0][1].billingCycle).toBe('yearly');
  });

  it('gift — paid period starts at the gift end and runs one full cycle; gift columns written', async () => {
    const endsAt = new Date(NOW.getTime() + 7 * 86_400_000);
    const t = setup({ gift: { granted: true, days: 7, startsAt: NOW, endsAt } });
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    const data = t.tenantSubscriptionsRepository.upsertForPlanPurchase.mock.calls[0][2];
    expect(data.gift).toEqual({ days: 7, startsAt: NOW, endsAt, paymentId: 'pay-1' });
    expect(data.currentPeriodStart).toEqual(endsAt);
    expect(data.currentPeriodEnd.toISOString()).toBe('2027-03-07T09:00:00.000Z');
  });

  it('renewal while active extends from the current end and asks the gift service with extendsCurrentPeriod=true', async () => {
    const currentEnd = new Date('2027-02-10T00:00:00.000Z');
    const t = setup({
      existing: { status: 'active', currentPeriodEnd: currentEnd, giftedDays: 7 },
    });
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never);
    const giftInput = t.gift.claimFirstPaidGift.mock.calls[0][1];
    expect(giftInput.extendsCurrentPeriod).toBe(true);
    expect(giftInput.existing).toEqual({ currentPeriodEnd: currentEnd, giftedDays: 7 });
    const data = t.tenantSubscriptionsRepository.upsertForPlanPurchase.mock.calls[0][2];
    expect(data.currentPeriodStart).toEqual(currentEnd);
    expect(data.gift).toBeUndefined();
  });

  it('passes the confirming source through to the gift ledger', async () => {
    const t = setup({});
    await t.service.applySuccessfulPayment(t.tx as never, t.payment as never, {
      source: 'gateway',
    });
    expect(t.gift.claimFirstPaidGift.mock.calls[0][1].source).toBe('gateway');
  });
});
