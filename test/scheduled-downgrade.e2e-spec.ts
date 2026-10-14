/**
 * B0-BIL-04 — a smaller plan bought while a paid period has more than a
 * week to run takes effect at the END of that period, not at approval.
 * The customer keeps the capacity they already paid for; the subscription
 * sweep switches the plan when the period closes. Upgrades still apply at
 * once, and cancelling drops a scheduled change.
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
import { SubscriptionExpiryService } from '../src/plans/services/subscription-expiry.service';

jest.setTimeout(60000);

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const DAY = 24 * 60 * 60 * 1000;

describe('Scheduled downgrade (e2e) — B0-BIL-04', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let reviewer: { userId: string; accessToken: string };

  async function signUp(label: string) {
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

  async function plan(label: string, students: number): Promise<Plan> {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        limits: {
          academies: 1,
          students,
          instructors: 3,
          staff: 3,
          courses: 20,
          generalStorage: 10,
          videoStorage: 30,
        },
        features: { liveSessions: false },
        pricing: { amount: 100, currency: 'EGP', billingCycle: 'monthly' },
      },
    });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    reviewer = await signUp('bil04-reviewer');
    await admin.user.update({
      where: { id: reviewer.userId },
      data: { isPlatformOwner: true },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  /** An organization on `current`, active, with `daysLeft` days of paid period left. */
  async function activeOn(label: string, current: Plan, daysLeft: number) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const end = new Date(Date.now() + daysLeft * DAY);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: current.id,
        status: 'active',
        billingCycle: 'monthly',
        currentPeriodStart: new Date(end.getTime() - 30 * DAY),
        currentPeriodEnd: end,
        grantedLimits: current.limits as object,
      },
    });
    return { owner, org, end };
  }

  async function buyAndApprove(
    orgId: string,
    ownerToken: string,
    target: Plan,
    label: string,
  ) {
    const method = await seedPaymentMethod(admin, `${label}-method`);
    const checkout = await request(app.getHttpServer())
      .post(`/organizations/${orgId}/checkouts`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: target.key },
        billingCycle: 'monthly',
        idempotencyKey: `${label}-${Date.now()}`,
      })
      .expect(201);
    const payment = await request(app.getHttpServer())
      .post(`/organizations/${orgId}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ checkoutId: checkout.body.id, methodKey: method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/organizations/${orgId}/payments/${payment.body.id}/proof`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/payments/${payment.body.id}/approve`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({})
      .expect(201);
  }

  it('keeps the paid plan until the period ends, then the sweep switches it', async () => {
    const big = await plan('bil04-big', 400);
    const small = await plan('bil04-small', 100);
    const { owner, org, end } = await activeOn('bil04-down', big, 20);

    await buyAndApprove(org.id, owner.accessToken, small, 'bil04-down');

    const scheduled = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(scheduled.planId).toBe(big.id);
    expect((scheduled.grantedLimits as { students: number }).students).toBe(400);
    expect(scheduled.scheduledPlanId).toBe(small.id);
    expect(scheduled.scheduledChangeAt?.getTime()).toBe(end.getTime());
    // The new paid period starts where the old one ends.
    expect(scheduled.currentPeriodStart?.getTime()).toBe(end.getTime());

    // The owner can see what is coming and when.
    const shown = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(shown.body.plan.id).toBe(big.id);
    expect(shown.body.scheduledChange).toEqual({
      planId: small.id,
      planName: small.name,
      effectiveAt: end.toISOString(),
    });

    // Not due yet: nothing changes.
    const expiry = app.get(SubscriptionExpiryService);
    await expiry.applyDueScheduledPlanChanges(new Date());
    expect(
      (
        await admin.tenantSubscription.findUniqueOrThrow({
          where: { organizationId: org.id },
        })
      ).planId,
    ).toBe(big.id);

    // At the period end the sweep applies it, once, with an audit row.
    const applied = await expiry.applyDueScheduledPlanChanges(
      new Date(end.getTime() + 1000),
    );
    expect(applied).toBeGreaterThanOrEqual(1);
    const after = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(after.planId).toBe(small.id);
    expect((after.grantedLimits as { students: number }).students).toBe(100);
    expect(after.scheduledPlanId).toBeNull();
    expect(after.scheduledChangeAt).toBeNull();
    expect(
      await admin.auditLogEntry.count({
        where: {
          organizationId: org.id,
          action: 'subscription.scheduled_plan_change_applied',
        },
      }),
    ).toBe(1);
  });

  it('applies an upgrade at once', async () => {
    const small = await plan('bil04-up-small', 100);
    const big = await plan('bil04-up-big', 400);
    const { owner, org } = await activeOn('bil04-up', small, 20);
    await buyAndApprove(org.id, owner.accessToken, big, 'bil04-up');
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(row.planId).toBe(big.id);
    expect(row.scheduledPlanId).toBeNull();
  });

  it('applies a downgrade at once in the last 7 days of the period', async () => {
    const big = await plan('bil04-late-big', 400);
    const small = await plan('bil04-late-small', 100);
    const { owner, org } = await activeOn('bil04-late', big, 3);
    await buyAndApprove(org.id, owner.accessToken, small, 'bil04-late');
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(row.planId).toBe(small.id);
    expect(row.scheduledPlanId).toBeNull();
  });

  it('drops a scheduled downgrade when the subscription is cancelled', async () => {
    const big = await plan('bil04-cancel-big', 400);
    const small = await plan('bil04-cancel-small', 100);
    const { owner, org } = await activeOn('bil04-cancel', big, 20);
    await buyAndApprove(org.id, owner.accessToken, small, 'bil04-cancel');
    expect(
      (
        await admin.tenantSubscription.findUniqueOrThrow({
          where: { organizationId: org.id },
        })
      ).scheduledPlanId,
    ).toBe(small.id);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/subscription/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ confirm: true, reason: 'too_expensive' })
      .expect((res) => expect(res.status).toBeLessThan(300));
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: org.id },
    });
    expect(row.cancelAtPeriodEnd).toBe(true);
    expect(row.scheduledPlanId).toBeNull();
    expect(row.planId).toBe(big.id);
  });
});
