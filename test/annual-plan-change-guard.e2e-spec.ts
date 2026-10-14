/**
 * CF-24 / B0-BIL-03 — a different plan cannot be bought self-serve while an
 * annual period has more than 30 days to run (until proration exists).
 * Renewing the same plan, or changing in the last 30 days, still works.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';

jest.setTimeout(30000);

async function signUpAndSignIn(app: INestApplication, label: string) {
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

const unique = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const DAY = 24 * 60 * 60 * 1000;

async function seedPlan(
  admin: PrismaClient,
  label: string,
  amount: number,
): Promise<Plan> {
  return admin.plan.create({
    data: {
      key: unique(label),
      name: label,
      limits: {
        academies: 1,
        students: 100,
        instructors: 3,
        staff: 3,
        courses: 20,
        generalStorage: 10,
        videoStorage: 30,
      },
      features: { liveSessions: false },
      pricing: { amount, currency: 'EGP', billingCycle: 'monthly' },
    },
  });
}

describe('Mid-annual plan change guard (e2e) — CF-24', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let owner: { userId: string; accessToken: string };
  let orgId: string;
  let current: Plan;
  let other: Plan;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    owner = await signUpAndSignIn(app, 'annual-guard-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'annual-guard-org');
    orgId = org.id;
    current = await seedPlan(admin, 'annual-guard-teacher', 1190);
    other = await seedPlan(admin, 'annual-guard-academy', 2790);
    await admin.tenantSubscription.create({
      data: {
        organizationId: orgId,
        planId: current.id,
        status: 'active',
        billingCycle: 'yearly',
        currentPeriodStart: new Date(Date.now() - 165 * DAY),
        currentPeriodEnd: new Date(Date.now() + 200 * DAY),
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const checkout = (planKey: string) =>
    request(app.getHttpServer())
      .post(`/organizations/${orgId}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey },
        idempotencyKey: unique('annual-checkout'),
      });

  it('refuses a different plan with 200 days of the annual period left', async () => {
    const res = await checkout(other.key).expect(409);
    expect(res.body.error.messageKey).toBe('errors.checkout.annualPlanChangeViaSupport');
  });

  it('allows renewing the same plan', async () => {
    await checkout(current.key).expect(201);
  });

  it('allows a different plan in the last 30 days', async () => {
    await admin.tenantSubscription.update({
      where: { organizationId: orgId },
      data: { currentPeriodEnd: new Date(Date.now() + 10 * DAY) },
    });
    await checkout(other.key).expect(201);
  });
});
