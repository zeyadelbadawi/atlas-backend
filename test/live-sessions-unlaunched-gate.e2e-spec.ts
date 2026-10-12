/**
 * B0-LIV-01 — while the Live Sessions add-on is not published (the test
 * database holds it as `coming_soon`, as production does), no customer can
 * link a Zoom account to it or make Atlas call Zoom: the connect
 * authorization, the OAuth callback and the connection check are refused
 * for the organization owner, before any state is minted or spent.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';

describe('Live Sessions — unlaunched add-on gate (e2e, B0-LIV-01)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let token: string;
  let userId: string;
  let academyId: string;
  let organizationId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    const email = uniqueTestEmail('liv01-owner');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Liv Owner', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    token = signIn.body.accessToken as string;
    userId = signIn.body.user.id as string;

    const org = await seedOrganizationWithOwner(admin, userId, 'liv01-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id, 'liv01-sub');
    academyId = (await seedAcademy(admin, org.id, 'liv01-academy')).id;
    await seedAcademyMember(admin, academyId, userId, 'owner');
  });

  afterAll(async () => {
    if (organizationId) {
      await admin.organization.delete({ where: { id: organizationId } }).catch(() => {});
    }
    await admin?.$disconnect();
    await app?.close();
  });

  it('the add-on really is unpublished in this database', async () => {
    const addOn = await admin.addOn.findUnique({ where: { key: 'live-sessions' } });
    expect(addOn?.catalogStatus).not.toBe('published');
  });

  const expectNotUsable = (res: request.Response) => {
    expect(res.status).toBe(403);
    expect(res.body.error.messageKey).toBe('errors.liveSessions.addOnNotUsable');
    expect(res.body.error.details).toEqual({ reason: 'coming_soon' });
  };

  it('refuses to start a Zoom authorization, and mints no state', async () => {
    const res = await request(app.getHttpServer())
      .post(`/academies/${academyId}/live-sessions/connection/authorize`)
      .set('Authorization', `Bearer ${token}`);
    expectNotUsable(res);
    expect(await admin.liveProviderOAuthState.count({ where: { academyId } })).toBe(0);
  });

  it('refuses the OAuth callback', async () => {
    const res = await request(app.getHttpServer())
      .post('/live-sessions/oauth/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'any-code', state: 'any-state-value-that-is-long-enough' });
    expectNotUsable(res);
  });

  it('refuses the connection check (no call to Zoom)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/academies/${academyId}/live-sessions/connection/check`)
      .set('Authorization', `Bearer ${token}`);
    expectNotUsable(res);
  });
});
