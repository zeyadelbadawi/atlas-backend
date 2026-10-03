/**
 * PaidGiftEligibilityService — the gifted-setup-days rules (W8A), asserted
 * from the direction of abuse. The ledger's real concurrency guarantee
 * (UNIQUE subject_hash + ON CONFLICT DO NOTHING) is a database property and
 * is proved end to end in `test/w8-gifted-days.e2e-spec.ts`; here the
 * service is shown to CONSULT it last and honour its answer.
 */
import { ConfigService } from '@nestjs/config';
import { CustomerIdentityHasher } from './customer-identity-hasher.service';
import {
  PaidGiftEligibilityService,
  type GiftDecisionInput,
} from './paid-gift-eligibility.service';
import { customerSubjectHashV2 } from '../utils/trial-subject.util';
import { deriveCustomerIdentityKey } from '../utils/customer-identity-key.util';

const PAYMENT_KEY = 'a'.repeat(64);
const NOW = new Date('2026-11-04T10:00:00.000Z');

function makeHasher(): CustomerIdentityHasher {
  const config = {
    getOrThrow: () => ({ credentialEncryptionKeyHex: PAYMENT_KEY }),
  } as unknown as ConfigService;
  return new CustomerIdentityHasher(config);
}

function makeTx(overrides: {
  priorPaid?: number;
  owner?: { id: string; email: string; status: string } | null;
  inserted?: number;
  ledgerRow?: { id: string } | null;
}) {
  return {
    payment: { count: jest.fn().mockResolvedValue(overrides.priorPaid ?? 0) },
    organization: {
      findUnique: jest.fn().mockResolvedValue(
        overrides.owner === null
          ? { owner: null }
          : {
              owner: overrides.owner ?? {
                id: 'owner-1',
                email: 'Owner.Name+billing@gmail.com',
                status: 'active',
              },
            },
      ),
    },
    paidGiftRedemption: {
      createMany: jest.fn().mockResolvedValue({ count: overrides.inserted ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(overrides.ledgerRow ?? null),
    },
  };
}

function input(overrides: Partial<GiftDecisionInput> = {}): GiftDecisionInput {
  return {
    organizationId: 'org-1',
    paymentId: 'pay-1',
    plan: { key: 'growth', giftedDaysMonthly: 7, giftedDaysYearly: 14 },
    billingCycle: 'monthly',
    extendsCurrentPeriod: false,
    existing: { currentPeriodEnd: null, giftedDays: null },
    now: NOW,
    source: 'approval',
    ...overrides,
  };
}

describe('PaidGiftEligibilityService.claimFirstPaidGift', () => {
  const service = new PaidGiftEligibilityService(makeHasher());

  it('grants N days from approval on a first-ever paid subscription and records the claim', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(tx as never, input());

    expect(decision).toEqual({
      granted: true,
      days: 7,
      startsAt: NOW,
      endsAt: new Date('2026-11-11T10:00:00.000Z'),
    });
    const row = tx.paidGiftRedemption.createMany.mock.calls[0][0];
    expect(row.skipDuplicates).toBe(true);
    expect(row.data[0]).toMatchObject({
      hashVersion: 2,
      organizationId: 'org-1',
      redeemedByUserId: 'owner-1',
      paymentId: 'pay-1',
      planKey: 'growth',
      billingCycle: 'monthly',
      giftedDays: 7,
      source: 'approval',
    });
  });

  it('keys the identity on the CANONICAL owner email (Gmail dots and +tag collapse)', async () => {
    const tx = makeTx({});
    await service.claimFirstPaidGift(tx as never, input());
    const key = deriveCustomerIdentityKey({ paymentCredentialsKeyHex: PAYMENT_KEY });
    expect(tx.paidGiftRedemption.createMany.mock.calls[0][0].data[0].subjectHash).toBe(
      customerSubjectHashV2('ownername@gmail.com', key),
    );
    // Never the address itself.
    expect(JSON.stringify(tx.paidGiftRedemption.createMany.mock.calls)).not.toContain(
      'gmail',
    );
  });

  it('uses the yearly configuration for a yearly purchase', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(
      tx as never,
      input({ billingCycle: 'yearly' }),
    );
    expect(decision).toMatchObject({ granted: true, days: 14 });
  });

  it('refuses when the ledger already holds this identity (second org, re-signup, alias)', async () => {
    const tx = makeTx({ inserted: 0 });
    const decision = await service.claimFirstPaidGift(tx as never, input());
    expect(decision).toEqual({ granted: false, reason: 'already_redeemed' });
  });

  it('refuses a renewal/plan change that extends a running paid period, without touching the ledger', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(
      tx as never,
      input({ extendsCurrentPeriod: true }),
    );
    expect(decision).toEqual({ granted: false, reason: 'not_fresh_start' });
    expect(tx.paidGiftRedemption.createMany).not.toHaveBeenCalled();
  });

  it('refuses when the plan has no gift for the cycle (NULL or 0)', async () => {
    for (const plan of [
      { key: 'p', giftedDaysMonthly: null, giftedDaysYearly: 14 },
      { key: 'p', giftedDaysMonthly: 0, giftedDaysYearly: 14 },
    ]) {
      const tx = makeTx({});
      expect(await service.claimFirstPaidGift(tx as never, input({ plan }))).toEqual({
        granted: false,
        reason: 'no_gift_configured',
      });
      expect(tx.paidGiftRedemption.createMany).not.toHaveBeenCalled();
    }
  });

  it('refuses a lapsed customer re-subscribing (organization already had a paid period)', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(
      tx as never,
      input({ existing: { currentPeriodEnd: new Date('2026-01-01'), giftedDays: null } }),
    );
    expect(decision).toEqual({ granted: false, reason: 'organization_already_paid' });
    expect(tx.paidGiftRedemption.createMany).not.toHaveBeenCalled();
  });

  it('refuses when the organization already received a gift', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(
      tx as never,
      input({ existing: { currentPeriodEnd: null, giftedDays: 7 } }),
    );
    expect(decision).toEqual({ granted: false, reason: 'organization_already_paid' });
  });

  it('refuses when another succeeded plan payment exists for the organization (excluding this one)', async () => {
    const tx = makeTx({ priorPaid: 1 });
    const decision = await service.claimFirstPaidGift(tx as never, input());
    expect(decision).toEqual({ granted: false, reason: 'organization_already_paid' });
    expect(tx.payment.count.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      status: 'succeeded',
      id: { not: 'pay-1' },
      checkout: { targetType: 'plan_subscription' },
    });
  });

  it('does NOT refuse a converting trialist (a trial never sets a paid period)', async () => {
    const tx = makeTx({});
    const decision = await service.claimFirstPaidGift(
      tx as never,
      input({ existing: { currentPeriodEnd: null, giftedDays: null } }),
    );
    expect(decision.granted).toBe(true);
  });

  it('refuses when the owner account is deleted', async () => {
    const tx = makeTx({
      owner: { id: 'o', email: 'deleted-x@account.invalid', status: 'deleted' },
    });
    expect(await service.claimFirstPaidGift(tx as never, input())).toEqual({
      granted: false,
      reason: 'owner_unavailable',
    });
  });

  it('records the gateway as the source when a webhook confirmed the money', async () => {
    const tx = makeTx({});
    await service.claimFirstPaidGift(tx as never, input({ source: 'gateway' }));
    expect(tx.paidGiftRedemption.createMany.mock.calls[0][0].data[0].source).toBe(
      'gateway',
    );
  });
});

describe('PaidGiftEligibilityService.describeGiftAvailability (display only)', () => {
  const service = new PaidGiftEligibilityService(makeHasher());

  it('is true for a never-paid organization whose owner never redeemed', async () => {
    const tx = makeTx({});
    expect(
      await service.describeGiftAvailability(tx as never, {
        organizationId: 'org-1',
        existing: { currentPeriodEnd: null, giftedDays: null },
      }),
    ).toBe(true);
  });

  it('is false once the identity has a ledger row, and never writes', async () => {
    const tx = makeTx({ ledgerRow: { id: 'r' } });
    expect(
      await service.describeGiftAvailability(tx as never, {
        organizationId: 'org-1',
        existing: null,
      }),
    ).toBe(false);
    expect(tx.paidGiftRedemption.createMany).not.toHaveBeenCalled();
  });
});
