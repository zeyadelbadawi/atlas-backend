/**
 * B0-BIL-07 — a Platform Owner's edit to a plan's price or limits notifies
 * every paying organization on that plan before it applies to them (their
 * next renewal), by email + in-app notice and a banner on the subscription
 * page. Trials, other plans and subscribers the edit does not change are
 * not told; a retried run sends nothing twice; reverting clears the
 * banner; the next paid renewal clears it too.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import { PlanChangeNoticeService } from '../src/platform/services/plan-change-notice.service';

jest.setTimeout(90000);

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const DAY = 24 * 60 * 60 * 1000;
const KEY = 'lifecycle.subscription.price_change_notice';

const LIMITS = {
  academies: 1,
  students: 100,
  instructors: 3,
  staff: 3,
  courses: 20,
  generalStorage: 10,
  videoStorage: 30,
  videoStorageMinutes: 1200,
  recordedSessions: 3,
};

interface Account {
  readonly userId: string;
  readonly accessToken: string;
}

describe('Plan price-change notice (e2e) — B0-BIL-07', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let platformOwner: Account;
  let plan: Plan;
  let otherPlan: Plan;
  // Paying, monthly, 20 days left — the main subscriber.
  let monthly: { owner: Account; orgId: string; end: Date };
  // Paying, yearly — unaffected by a monthly-only price change.
  let yearly: { owner: Account; orgId: string };
  // Paying, in grace — told, but without a date.
  let grace: { owner: Account; orgId: string };
  // Trialing on the plan — never told.
  let trial: { owner: Account; orgId: string };
  // Paying on a different plan — never told.
  let elsewhere: { owner: Account; orgId: string };

  async function signUp(label: string): Promise<Account> {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  async function seedPlan(label: string): Promise<Plan> {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        limits: LIMITS,
        features: { liveSessions: false },
        pricing: {
          amount: 1190,
          currency: 'EGP',
          billingCycle: 'monthly',
          yearlyAmount: 11900,
        },
      },
    });
  }

  async function subscriber(
    label: string,
    onPlan: Plan,
    data: {
      status: 'active' | 'grace_period' | 'trialing';
      billingCycle?: 'monthly' | 'yearly';
      daysLeft?: number;
    },
  ) {
    await flush();
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const end = new Date(Date.now() + (data.daysLeft ?? 20) * DAY);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: onPlan.id,
        status: data.status,
        billingCycle: data.billingCycle ?? null,
        currentPeriodStart: new Date(end.getTime() - 30 * DAY),
        currentPeriodEnd: end,
        grantedLimits: LIMITS,
        ...(data.status === 'grace_period'
          ? { graceEndsAt: new Date(Date.now() + 3 * DAY) }
          : {}),
        ...(data.status === 'trialing' ? { trialEndsAt: end } : {}),
      },
    });
    return { owner, orgId: org.id, end };
  }

  async function patchPlan(body: Record<string, unknown>) {
    const current = await admin.plan.findUniqueOrThrow({ where: { id: plan.id } });
    return request(app.getHttpServer())
      .patch(`/platform-plans/${plan.key}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ expectedVersion: current.version, ...body })
      .expect(200);
  }

  const noticesFor = (userId: string) =>
    admin.communicationOutbox.count({ where: { key: KEY, recipientUserId: userId } });

  const subscription = (orgId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/organizations/${orgId}/subscription`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    platformOwner = await signUp('bil07-platform-owner');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
    plan = await seedPlan('bil07-plan');
    otherPlan = await seedPlan('bil07-other');

    monthly = await subscriber('bil07-monthly', plan, {
      status: 'active',
      billingCycle: 'monthly',
    });
    yearly = await subscriber('bil07-yearly', plan, {
      status: 'active',
      billingCycle: 'yearly',
    });
    grace = await subscriber('bil07-grace', plan, {
      status: 'grace_period',
      billingCycle: 'monthly',
      daysLeft: -2,
    });
    trial = await subscriber('bil07-trial', plan, { status: 'trialing' });
    elsewhere = await subscriber('bil07-elsewhere', otherPlan, {
      status: 'active',
      billingCycle: 'monthly',
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  it('notifies each affected paying organization once, and nobody else', async () => {
    await patchPlan({
      pricing: {
        amount: 1390,
        currency: 'EGP',
        billingCycle: 'monthly',
        yearlyAmount: 11900,
      },
    });

    expect(await noticesFor(monthly.owner.userId)).toBe(1);
    expect(await noticesFor(grace.owner.userId)).toBe(1);
    // Yearly price unchanged; a trial; another plan.
    expect(await noticesFor(yearly.owner.userId)).toBe(0);
    expect(await noticesFor(trial.owner.userId)).toBe(0);
    expect(await noticesFor(elsewhere.owner.userId)).toBe(0);

    const audit = await admin.auditLogEntry.findFirstOrThrow({
      where: { action: 'plan.subscribers_notified', targetId: plan.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.context).toMatchObject({ notified: 2, cleared: 0, failed: 0 });
  });

  it('returns the banner data on the subscription read', async () => {
    const res = await subscription(monthly.orgId, monthly.owner.accessToken);
    expect(res.body.priceChangeNotice).toMatchObject({
      planId: plan.id,
      planName: 'bil07-plan',
      billingCycle: 'monthly',
      fromPrice: { amount: 1190, currency: 'EGP' },
      toPrice: { amount: 1390, currency: 'EGP' },
      limitChanges: {},
      effectiveAt: monthly.end.toISOString(),
    });

    const graceRes = await subscription(grace.orgId, grace.owner.accessToken);
    expect(graceRes.body.priceChangeNotice.toPrice).toEqual({
      amount: 1390,
      currency: 'EGP',
    });
    expect(graceRes.body.priceChangeNotice.effectiveAt).toBeUndefined();

    const untouched = await subscription(yearly.orgId, yearly.owner.accessToken);
    expect(untouched.body.priceChangeNotice).toBeUndefined();
  });

  it('sends nothing twice when the same edit is processed again', async () => {
    const current = await admin.plan.findUniqueOrThrow({ where: { id: plan.id } });
    const previous = {
      ...current,
      pricing: {
        amount: 1190,
        currency: 'EGP',
        billingCycle: 'monthly',
        yearlyAmount: 11900,
      },
    };
    await app
      .get(PlanChangeNoticeService)
      .notifySubscribers(platformOwner.userId, previous, current);
    expect(await noticesFor(monthly.owner.userId)).toBe(1);
    expect(await noticesFor(grace.owner.userId)).toBe(1);
  });

  it('clears the banner when a later edit puts the price back', async () => {
    await patchPlan({
      pricing: {
        amount: 1190,
        currency: 'EGP',
        billingCycle: 'monthly',
        yearlyAmount: 11900,
      },
    });
    const res = await subscription(monthly.orgId, monthly.owner.accessToken);
    expect(res.body.priceChangeNotice).toBeUndefined();
    const audit = await admin.auditLogEntry.findFirstOrThrow({
      where: { action: 'plan.subscribers_notified', targetId: plan.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.context).toMatchObject({ notified: 0, cleared: 2 });
  });

  it('tells every paying cycle about a limit change, listing each limit', async () => {
    await patchPlan({ limits: { ...LIMITS, students: 200 } });

    // A new plan version is a new message, even for the same organization.
    expect(await noticesFor(monthly.owner.userId)).toBe(2);
    expect(await noticesFor(yearly.owner.userId)).toBe(1);
    expect(await noticesFor(trial.owner.userId)).toBe(0);

    const res = await subscription(yearly.orgId, yearly.owner.accessToken);
    expect(res.body.priceChangeNotice).toMatchObject({
      billingCycle: 'yearly',
      fromPrice: { amount: 11900, currency: 'EGP' },
      toPrice: { amount: 11900, currency: 'EGP' },
      limitChanges: { students: { from: 100, to: 200 } },
    });
  });

  it('lets only the billing owner dismiss the banner', async () => {
    await request(app.getHttpServer())
      .post(`/organizations/${monthly.orgId}/subscription/price-change-notice/dismiss`)
      .set('Authorization', `Bearer ${elsewhere.owner.accessToken}`)
      .expect(403);

    const first = await request(app.getHttpServer())
      .post(`/organizations/${monthly.orgId}/subscription/price-change-notice/dismiss`)
      .set('Authorization', `Bearer ${monthly.owner.accessToken}`)
      .expect(200);
    expect(first.body).toEqual({ dismissed: true });

    const again = await request(app.getHttpServer())
      .post(`/organizations/${monthly.orgId}/subscription/price-change-notice/dismiss`)
      .set('Authorization', `Bearer ${monthly.owner.accessToken}`)
      .expect(200);
    expect(again.body).toEqual({ dismissed: false });

    const res = await subscription(monthly.orgId, monthly.owner.accessToken);
    expect(res.body.priceChangeNotice).toBeUndefined();
  });

  it('is cleared by the next paid renewal', async () => {
    const before = await subscription(yearly.orgId, yearly.owner.accessToken);
    expect(before.body.priceChangeNotice).toBeDefined();

    const method = await seedPaymentMethod(admin, `bil07-method-${Date.now()}`);
    const checkout = await request(app.getHttpServer())
      .post(`/organizations/${yearly.orgId}/checkouts`)
      .set('Authorization', `Bearer ${yearly.owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: plan.key },
        billingCycle: 'yearly',
        idempotencyKey: `bil07-renewal-${Date.now()}`,
      })
      .expect(201);
    const payment = await request(app.getHttpServer())
      .post(`/organizations/${yearly.orgId}/payments`)
      .set('Authorization', `Bearer ${yearly.owner.accessToken}`)
      .send({ checkoutId: checkout.body.id, methodKey: method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/organizations/${yearly.orgId}/payments/${payment.body.id}/proof`)
      .set('Authorization', `Bearer ${yearly.owner.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/payments/${payment.body.id}/approve`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({})
      .expect(201);

    const after = await subscription(yearly.orgId, yearly.owner.accessToken);
    expect(after.body.priceChangeNotice).toBeUndefined();
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: yearly.orgId },
    });
    expect(row.priceChangeNotice).toBeNull();
  });
});
