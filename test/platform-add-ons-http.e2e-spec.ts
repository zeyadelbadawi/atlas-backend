/**
 * Add-ons Management over HTTP — the authorization boundary and the
 * status-change round trip, exercised the way the frontend and a curl
 * both would.
 *
 * The service-level behaviour (counts, versioning, audit, RLS) is proven
 * in `platform-add-ons-management.e2e-spec.ts`. What this file pins is the
 * edge: an anonymous caller gets 401, a tenant user gets 403, a Platform
 * Owner gets 200 — and a status change persists and is visible on the next
 * read, with a stale version rejected as 409.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';

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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Platform Add-ons Management (HTTP boundary)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let platformOwner: { userId: string; accessToken: string };
  let tenantUser: { userId: string; accessToken: string };
  const key = `httpsuite-${Date.now()}`;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    platformOwner = await signUpAndSignIn(app, 'addon-http-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
    tenantUser = await signUpAndSignIn(app, 'addon-http-tenant');

    await admin.addOn.create({
      data: {
        key,
        name: `ZZ HTTP ${key}`,
        description: 'HTTP suite add-on.',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: ['growth'],
        catalogStatus: 'draft',
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

  it('401s an anonymous list request', async () => {
    await request(app.getHttpServer()).get('/platform-add-ons').expect(401);
  });

  it('403s a tenant (non-platform) user', async () => {
    await request(app.getHttpServer())
      .get('/platform-add-ons')
      .set('Authorization', `Bearer ${tenantUser.accessToken}`)
      .expect(403);
  });

  it('200s a Platform Owner and lists add-ons including our key', async () => {
    const res = await request(app.getHttpServer())
      .get('/platform-add-ons')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    const keys = (res.body.items as { key: string }[]).map((r) => r.key);
    expect(keys).toContain(key);
  });

  it('401s an anonymous status change', async () => {
    await request(app.getHttpServer())
      .patch(`/platform-add-ons/${key}/status`)
      .send({ catalogStatus: 'published', expectedVersion: 0 })
      .expect(401);
  });

  it('403s a tenant user attempting a status change', async () => {
    await request(app.getHttpServer())
      .patch(`/platform-add-ons/${key}/status`)
      .set('Authorization', `Bearer ${tenantUser.accessToken}`)
      .send({ catalogStatus: 'published', expectedVersion: 0 })
      .expect(403);
  });

  it('400s an invalid catalog status', async () => {
    await request(app.getHttpServer())
      .patch(`/platform-add-ons/${key}/status`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ catalogStatus: 'archived', expectedVersion: 0 })
      .expect(400);
  });

  it('publishes the add-on and reflects it on the next read', async () => {
    const before = await request(app.getHttpServer())
      .get('/platform-add-ons')
      .query({ search: key, pageSize: 100 })
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    const row = (before.body.items as { key: string; version: number }[]).find(
      (r) => r.key === key,
    );

    const patched = await request(app.getHttpServer())
      .patch(`/platform-add-ons/${key}/status`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ catalogStatus: 'published', expectedVersion: row!.version })
      .expect(200);
    expect(patched.body.catalogStatus).toBe('published');
    expect(patched.body.version).toBe(row!.version + 1);

    // A stale retry (the version we already consumed) is a 409.
    await request(app.getHttpServer())
      .patch(`/platform-add-ons/${key}/status`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .send({ catalogStatus: 'draft', expectedVersion: row!.version })
      .expect(409);
  });
});
