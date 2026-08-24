/**
 * Plan/Add-on catalog + Trial Policy — functional/contract e2e suite (P4,
 * master plan §21). Platform-owned resources: every authenticated caller
 * reads the same list, no organization scoping.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedAddOn, seedPlan } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

describe('Plan/Add-on catalog + Trial Policy (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it('requires authentication on every route', async () => {
    await request(app.getHttpServer()).get('/plans').expect(401);
    await request(app.getHttpServer()).get('/add-ons').expect(401);
    await request(app.getHttpServer()).get('/trial-policy').expect(401);
    await request(app.getHttpServer()).patch('/trial-policy').send({}).expect(401);
  });

  it('GET /plans returns real, previously-seeded plans field-for-field', async () => {
    const user = await signUpAndSignIn(app, 'plans-list');
    const plan = await seedPlan(admin, 'plans-list-plan', {
      limits: {
        academies: 3,
        students: 10,
        instructors: 2,
        staff: 2,
        courses: 5,
        generalStorage: 1,
        videoStorage: 1,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/plans')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const found = response.body.find((p: { id: string }) => p.id === plan.id);
    expect(found).toMatchObject({
      key: plan.key,
      name: plan.name,
      status: 'active',
      limits: { academies: 3 },
    });
  });

  it('GET /plans includes archived plans too (frontend disables selection client-side, never hides them server-side)', async () => {
    const user = await signUpAndSignIn(app, 'plans-archived');
    const plan = await seedPlan(admin, 'plans-archived-plan', { status: 'archived' });

    const response = await request(app.getHttpServer())
      .get('/plans')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const found = response.body.find((p: { id: string }) => p.id === plan.id);
    expect(found?.status).toBe('archived');
  });

  it('GET /plans/:key returns 404 for an unknown key', async () => {
    const user = await signUpAndSignIn(app, 'plans-404');
    await request(app.getHttpServer())
      .get('/plans/does-not-exist')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
  });

  it('GET /add-ons returns real add-ons with the effect discriminated union intact', async () => {
    const user = await signUpAndSignIn(app, 'addons-list');
    const addOn = await seedAddOn(
      admin,
      'addons-list-addon',
      { type: 'limit', limitKey: 'staff', amount: 2 },
      ['starter'],
    );

    const response = await request(app.getHttpServer())
      .get('/add-ons')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const found = response.body.find((a: { id: string }) => a.id === addOn.id);
    expect(found.effect).toEqual({ type: 'limit', limitKey: 'staff', amount: 2 });
    expect(found.compatiblePlanKeys).toEqual(['starter']);
  });

  it('GET /add-ons/:key returns 404 for an unknown key', async () => {
    const user = await signUpAndSignIn(app, 'addons-404');
    await request(app.getHttpServer())
      .get('/add-ons/does-not-exist')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
  });

  it('GET /trial-policy is readable by any authenticated user (no role gate on read)', async () => {
    const user = await signUpAndSignIn(app, 'trial-read');
    const response = await request(app.getHttpServer())
      .get('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(typeof response.body.enabled).toBe('boolean');
    expect(typeof response.body.durationDays).toBe('number');
  });

  it('PATCH /trial-policy is rejected for a non-platform-owner with 403', async () => {
    const user = await signUpAndSignIn(app, 'trial-forbidden');
    await request(app.getHttpServer())
      .patch('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ enabled: false, durationDays: 0 })
      .expect(403);
  });

  it('PATCH /trial-policy succeeds for a platform owner and persists', async () => {
    const user = await signUpAndSignIn(app, 'trial-owner');
    await makePlatformOwner(admin, user.userId);

    const updated = await request(app.getHttpServer())
      .patch('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ enabled: true, durationDays: 14 })
      .expect(200);
    expect(updated.body).toEqual({ enabled: true, durationDays: 14 });

    const reread = await request(app.getHttpServer())
      .get('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(reread.body).toEqual({ enabled: true, durationDays: 14 });
  });

  it('PATCH /trial-policy rejects an invalid payload (negative durationDays) with 400', async () => {
    const user = await signUpAndSignIn(app, 'trial-invalid');
    await makePlatformOwner(admin, user.userId);

    await request(app.getHttpServer())
      .patch('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ enabled: true, durationDays: -1 })
      .expect(400);
  });

  it('PATCH /trial-policy rejects a missing required field with 400', async () => {
    const user = await signUpAndSignIn(app, 'trial-missing');
    await makePlatformOwner(admin, user.userId);

    await request(app.getHttpServer())
      .patch('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ enabled: true })
      .expect(400);
  });

  it('durationDays: 0 is a legitimate value regardless of enabled (no invented minimum)', async () => {
    const user = await signUpAndSignIn(app, 'trial-zero');
    await makePlatformOwner(admin, user.userId);

    const response = await request(app.getHttpServer())
      .patch('/trial-policy')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ enabled: true, durationDays: 0 })
      .expect(200);
    expect(response.body.durationDays).toBe(0);
  });
});
