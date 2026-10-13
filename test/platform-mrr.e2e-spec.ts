/**
 * B0-ANL-01 — the Platform Owner subscriptions overview reports monthly
 * recurring revenue from APPROVED subscription payments, per currency:
 * each active period's latest approved plan payment, yearly ÷ 12. A period
 * with no approved payment is counted, never valued at list price; failed
 * payments, add-on payments and ended periods add nothing.
 *
 * The database is shared with other suites, so every assertion is a delta
 * in `XTS` — the ISO 4217 code reserved for testing, which no other suite
 * uses.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner, seedPlan } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct-horse-battery';
const CURRENCY = 'XTS';

describe('B0-ANL-01 platform MRR (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let operatorAuth: { Authorization: string };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function tenant(
    label: string,
    subscription: {
      status: 'active' | 'expired' | 'trialing';
      billingCycle?: 'monthly' | 'yearly';
      currentPeriodEnd?: Date;
    },
  ) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-plan`);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: plan.id,
        status: subscription.status,
        billingCycle: subscription.billingCycle ?? null,
        currentPeriodStart: new Date(Date.now() - DAY),
        currentPeriodEnd:
          subscription.currentPeriodEnd ?? new Date(Date.now() + 20 * DAY),
      },
    });
    return { org, plan };
  }

  async function payment(
    organizationId: string,
    options: {
      amount: bigint;
      cycle?: 'monthly' | 'yearly';
      status?: 'succeeded' | 'failed';
      targetType?: 'plan_subscription' | 'add_on';
      createdAt?: Date;
    },
  ) {
    const checkout = await admin.checkout.create({
      data: {
        organizationId,
        targetType: options.targetType ?? 'plan_subscription',
        targetKey: 'plan',
        billingCycle: options.cycle ?? null,
        snapshot: {},
        status: 'completed',
        expiresAt: new Date(Date.now() + DAY),
        idempotencyKey: `anl01-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    await admin.payment.create({
      data: {
        organizationId,
        checkoutId: checkout.id,
        methodKey: 'manual_bank_transfer',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: options.amount,
        currency: CURRENCY,
        status: options.status ?? 'succeeded',
        createdAt: options.createdAt,
      },
    });
  }

  async function overview() {
    const res = await request(app.getHttpServer())
      .get('/platform-subscriptions/overview')
      .set(operatorAuth)
      .expect(200);
    return res.body;
  }

  function xts(body: {
    revenue: {
      mrr: { currency: string; monthlyAmountMinorUnits: number; subscriptions: number }[];
    };
  }) {
    return (
      body.revenue.mrr.find((row) => row.currency === CURRENCY) ?? {
        monthlyAmountMinorUnits: 0,
        subscriptions: 0,
      }
    );
  }

  it('values active periods by their latest approved plan payment, yearly ÷ 12, and counts the unpaid ones', async () => {
    const operator = await signUp('anl01-operator');
    await admin.user.update({
      where: { id: operator.userId },
      data: { isPlatformOwner: true },
    });
    operatorAuth = operator.auth;

    const before = await overview();
    expect(before.revenue.tracked).toBe(true);
    expect(before.revenue.excludesInternalOrganizations).toBe(true);

    // Monthly: 1,190.00 a month.
    const monthly = await tenant('anl01-monthly', {
      status: 'active',
      billingCycle: 'monthly',
    });
    await payment(monthly.org.id, { amount: 119_000n, cycle: 'monthly' });

    // Yearly: an older 9,000.00 payment, then the current 12,000.00 → 1,000.00 a month.
    const yearly = await tenant('anl01-yearly', {
      status: 'active',
      billingCycle: 'yearly',
      currentPeriodEnd: new Date(Date.now() + 300 * DAY),
    });
    await payment(yearly.org.id, {
      amount: 900_000n,
      cycle: 'yearly',
      createdAt: new Date(Date.now() - 400 * DAY),
    });
    await payment(yearly.org.id, { amount: 1_200_000n, cycle: 'yearly' });
    // A failed payment and an add-on payment never count.
    await payment(yearly.org.id, {
      amount: 5_000_000n,
      cycle: 'yearly',
      status: 'failed',
    });
    await payment(yearly.org.id, { amount: 7_000n, targetType: 'add_on' });

    // Active with no approved plan payment (e.g. granted by the platform).
    await tenant('anl01-granted', { status: 'active', billingCycle: 'monthly' });

    // An ended period adds nothing, even with an approved payment.
    const lapsed = await tenant('anl01-lapsed', {
      status: 'expired',
      billingCycle: 'monthly',
      currentPeriodEnd: new Date(Date.now() - 10 * DAY),
    });
    await payment(lapsed.org.id, { amount: 119_000n, cycle: 'monthly' });

    const after = await overview();
    expect(xts(after).monthlyAmountMinorUnits - xts(before).monthlyAmountMinorUnits).toBe(
      119_000 + 100_000,
    );
    expect(xts(after).subscriptions - xts(before).subscriptions).toBe(2);
    expect(after.revenue.activeSubscriptions - before.revenue.activeSubscriptions).toBe(
      3,
    );
    expect(after.revenue.activeWithoutPayment - before.revenue.activeWithoutPayment).toBe(
      1,
    );

    // Status × cycle counts move with the seeded rows.
    const cycle = (body: typeof after, status: string, key: string) =>
      body.subscriptions.byStatusAndCycle[status]?.[key] ?? 0;
    expect(cycle(after, 'active', 'monthly') - cycle(before, 'active', 'monthly')).toBe(
      2,
    );
    expect(cycle(after, 'active', 'yearly') - cycle(before, 'active', 'yearly')).toBe(1);
    expect(cycle(after, 'expired', 'monthly') - cycle(before, 'expired', 'monthly')).toBe(
      1,
    );
  });

  it('B0-ANL-04: an organization marked internal leaves MRR and the active counts; the change is audited once', async () => {
    const internal = await tenant('anl04-internal', {
      status: 'active',
      billingCycle: 'monthly',
    });
    await payment(internal.org.id, { amount: 50_000n, cycle: 'monthly' });
    const counted = await overview();

    const flagged = await request(app.getHttpServer())
      .patch(`/platform-organizations/${internal.org.id}/flags`)
      .set(operatorAuth)
      .send({ isInternal: true })
      .expect(200);
    expect(flagged.body).toMatchObject({
      organizationId: internal.org.id,
      isInternal: true,
    });
    // Setting the same value again changes and audits nothing.
    await request(app.getHttpServer())
      .patch(`/platform-organizations/${internal.org.id}/flags`)
      .set(operatorAuth)
      .send({ isInternal: true })
      .expect(200);

    const excluded = await overview();
    expect(
      xts(counted).monthlyAmountMinorUnits - xts(excluded).monthlyAmountMinorUnits,
    ).toBe(50_000);
    expect(
      counted.revenue.activeSubscriptions - excluded.revenue.activeSubscriptions,
    ).toBe(1);

    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'organization.internal_flag_changed', targetId: internal.org.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].context).toEqual({ isInternal: true, previousIsInternal: false });

    const read = await request(app.getHttpServer())
      .get(`/platform-organizations/${internal.org.id}/flags`)
      .set(operatorAuth)
      .expect(200);
    expect(read.body.isInternal).toBe(true);

    // Switching it back counts the organization again.
    await request(app.getHttpServer())
      .patch(`/platform-organizations/${internal.org.id}/flags`)
      .set(operatorAuth)
      .send({ isInternal: false })
      .expect(200);
    const restored = await overview();
    expect(xts(restored).monthlyAmountMinorUnits).toBe(
      xts(counted).monthlyAmountMinorUnits,
    );
  });

  it('B0-ANL-04: tenants can neither call the flags API nor read the flags table', async () => {
    const internal = await tenant('anl04-tenant', {
      status: 'active',
      billingCycle: 'monthly',
    });
    await request(app.getHttpServer())
      .patch(`/platform-organizations/${internal.org.id}/flags`)
      .set(operatorAuth)
      .send({ isInternal: true })
      .expect(200);

    const owner = await admin.organization.findUniqueOrThrow({
      where: { id: internal.org.id },
      select: { ownerUserId: true },
    });
    const tenancy = app.get(TenancyContextService);
    const asTenant = await tenancy.runInTenantAndUserContext(
      internal.org.id,
      owner.ownerUserId,
      (tx) =>
        tx.organizationPlatformFlags.findMany({
          where: { organizationId: internal.org.id },
        }),
    );
    expect(asTenant).toEqual([]);
    await expect(
      tenancy.runInTenantAndUserContext(internal.org.id, owner.ownerUserId, (tx) =>
        tx.organizationPlatformFlags.update({
          where: { organizationId: internal.org.id },
          data: { isInternal: false },
        }),
      ),
    ).rejects.toThrow();

    const someone = await signUp('anl04-someone');
    await request(app.getHttpServer())
      .patch(`/platform-organizations/${internal.org.id}/flags`)
      .set(someone.auth)
      .send({ isInternal: false })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/platform-organizations/${internal.org.id}/flags`)
      .set(someone.auth)
      .expect(403);
  });

  it('is refused to anyone who is not a Platform Owner', async () => {
    const someone = await signUp('anl01-someone');
    await request(app.getHttpServer())
      .get('/platform-subscriptions/overview')
      .set(someone.auth)
      .expect(403);
  });
});
