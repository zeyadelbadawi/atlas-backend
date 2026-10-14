/**
 * B0-BIL-11 — hidden plans (founding price locks, Enterprise deals).
 *
 * A Platform Owner can create a plan with `displayOrder: 0` and its own
 * family/tier through the API. It never appears in a catalog list, but a
 * customer given its key can read it and buy it, and an API-created plan
 * is not trial-eligible unless the Platform Owner says so.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';

jest.setTimeout(60000);

const LIMITS = {
  academies: 1,
  students: 100,
  instructors: 3,
  staff: 3,
  courses: 20,
  generalStorage: 10,
  videoStorage: 30,
  videoStorageMinutes: 100,
  recordedSessions: 0,
};

describe('Hidden plans (e2e) — B0-BIL-11', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let platformOwner: { userId: string; accessToken: string };
  const key = `bil11-founding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    platformOwner = await signUp('bil11-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
  });

  afterAll(async () => {
    await admin.plan.updateMany({ where: { key }, data: { status: 'archived' } });
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  it('creates a hidden plan with its family and tier', async () => {
    const res = await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({
        key,
        name: 'Founding Teacher',
        displayOrder: 0,
        limits: LIMITS,
        features: { liveSessions: false },
        pricing: { amount: 990, currency: 'EGP', billingCycle: 'monthly' },
        family: 'normal',
        tier: 'enterprise',
      })
      .expect(201);
    expect(res.body.tier).toBe('enterprise');
    const row = await admin.plan.findUniqueOrThrow({ where: { key } });
    expect(row.family).toBe('normal');
    expect(row.tier).toBe('enterprise');
    expect(row.displayOrder).toBe(0);
    expect(row.trialEligible).toBe(false);
  });

  it('refuses an unknown family or tier', async () => {
    await request(app.getHttpServer())
      .post('/platform-plans')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({
        key: `${key}-bad`,
        name: 'Bad',
        displayOrder: 0,
        limits: LIMITS,
        features: { liveSessions: false },
        tier: 'platinum',
      })
      .expect(400);
  });

  it('stays out of every list, but a customer with the key can read and buy it', async () => {
    const owner = await signUp('bil11-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'bil11-org');

    const publicList = await request(app.getHttpServer())
      .get('/public/plans')
      .expect(200);
    expect(JSON.stringify(publicList.body)).not.toContain(key);
    const list = await request(app.getHttpServer())
      .get('/plans')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(JSON.stringify(list.body)).not.toContain(key);

    const byKey = await request(app.getHttpServer())
      .get(`/plans/${key}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(byKey.body.pricing.amount).toBe(990);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: key },
        billingCycle: 'monthly',
        idempotencyKey: `bil11-${Date.now()}`,
      })
      .expect(201);
  });
});
