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
  // `trial_policy` is a real, GLOBAL, non-tenant-scoped singleton — every
  // PATCH in this file mutates the one shared row real signups also read
  // (`OrganizationSubscriptionBootstrapService`). Confirmed live, twice
  // over separate phases of this project, that leaving it mutated (this
  // file's own "durationDays: 0 is a legitimate value" test is the
  // reproducible culprit) breaks real trial bootstrapping for every
  // organization created afterward, including by a real human testing the
  // real app, until someone notices and manually repairs it. Snapshot
  // before this file's own writes and restore after, exactly like a
  // tenant-scoped fixture would be torn down — this table has no tenant
  // boundary to protect it, so this file's own discipline is the only
  // thing that can.
  let originalTrialPolicy: { enabled: boolean; durationDays: number };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    const policy = await admin.trialPolicy.findFirstOrThrow();
    originalTrialPolicy = { enabled: policy.enabled, durationDays: policy.durationDays };
  });

  afterAll(async () => {
    await admin.trialPolicy.updateMany({ data: originalTrialPolicy });
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

  /**
   * checkout/plans investigation fix: `GET /plans` is now scoped to
   * `CUSTOMER_FACING_WHERE` (`PlansRepository`'s own doc comment) — real,
   * `status: 'active'`, `displayOrder > 0` plans ONLY. `starter`/`growth`/
   * `enterprise` (`prisma/seed.ts`) are the only rows that have ever been
   * given a real `displayOrder`, so this reads real, always-present
   * catalog data rather than a throwaway fixture plan — which, as of this
   * same fix, would never appear in this response at all (see the next
   * test, which asserts exactly that).
   */
  it('GET /plans returns the real, customer-facing catalog field-for-field', async () => {
    const user = await signUpAndSignIn(app, 'plans-list');

    // Also confirms the envelope shape itself (`{ items, pagination }`,
    // never a bare array).
    const firstPage = await request(app.getHttpServer())
      .get('/plans')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(firstPage.body.pagination).toMatchObject({ page: 1, pageSize: 100 });

    const keys = firstPage.body.items.map((p: { key: string }) => p.key);
    expect(keys).toEqual(['starter', 'growth', 'enterprise']);

    const growth = firstPage.body.items.find((p: { key: string }) => p.key === 'growth');
    expect(growth).toMatchObject({
      key: 'growth',
      name: 'Growth',
      status: 'active',
      displayOrder: 2,
      pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
    });
  });

  /**
   * checkout/plans investigation fix: this used to document the OPPOSITE,
   * previously-intended contract ("frontend disables selection client-
   * side, never hides them server-side") — the real incident this phase
   * fixed is exactly that gap: an inert (`displayOrder: 0`) or archived
   * plan reaching a real customer's catalog/checkout at all. The new,
   * deliberate contract is server-side exclusion — `GET /plans/:key`
   * (direct, by a caller who already knows the key) still resolves it
   * unchanged, so nothing that depended on a specific already-known plan
   * key breaks; only anonymous catalog BROWSING is scoped.
   */
  it('GET /plans excludes archived and non-customer-facing (fixture) plans; GET /plans/:key still resolves them directly', async () => {
    const user = await signUpAndSignIn(app, 'plans-archived');
    const archived = await seedPlan(admin, 'plans-archived-plan', { status: 'archived' });
    const fixture = await seedPlan(admin, 'plans-fixture-plan', { status: 'active' });

    const catalog = await request(app.getHttpServer())
      .get('/plans')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    const keys = catalog.body.items.map((p: { key: string }) => p.key);
    expect(keys).not.toContain(archived.key);
    expect(keys).not.toContain(fixture.key);
    expect(keys).toEqual(['starter', 'growth', 'enterprise']);

    const byKey = await request(app.getHttpServer())
      .get(`/plans/${archived.key}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(byKey.body.status).toBe('archived');
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
