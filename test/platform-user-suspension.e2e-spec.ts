/**
 * B0-SEC-07 — the Platform Owner suspends and reinstates a user, against
 * real Postgres. A suspension ends every session at once (the next request
 * with the old access token is refused) and sign-in is refused; it is
 * audited with the operator's reason; reinstating restores sign-in. Only
 * a Platform Owner may do it, never on their own account or another
 * Platform Owner's, and a reason is required.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('Platform Owner user suspension (e2e, B0-SEC-07)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let platformOwner: { userId: string; accessToken: string };

  async function signUpAndSignIn(label: string) {
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
      accessToken: signIn.body.accessToken as string,
      email,
    };
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
    platformOwner = await signUpAndSignIn('sus-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const act = (
    token: string,
    userId: string,
    action: 'suspend' | 'unsuspend',
    body: object,
  ) =>
    request(app.getHttpServer())
      .post(`/platform-user-management/${userId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('suspends: sessions end now, sign-in is refused, the reason is audited; reinstating restores sign-in', async () => {
    const target = await signUpAndSignIn('sus-target');
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(200);

    const suspended = await act(platformOwner.accessToken, target.userId, 'suspend', {
      reason: 'Abusive uploads reported by three academies',
    }).expect(200);
    expect(suspended.body).toMatchObject({ status: 'suspended' });
    expect(suspended.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: target.userId } })).status,
    ).toBe('suspended');

    // The access token issued before the suspension stops working at once.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .expect(401);
    const refused = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: target.email, password: PASSWORD });
    expect(refused.status).toBe(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.accountSuspended');

    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'account.suspended', targetId: target.userId },
    });
    expect(audit?.actorUserId).toBe(platformOwner.userId);
    expect(audit?.context).toMatchObject({
      reason: 'Abusive uploads reported by three academies',
    });

    // Suspending again is a no-op, not an error.
    await act(platformOwner.accessToken, target.userId, 'suspend', {
      reason: 'again',
    }).expect(200);

    await act(platformOwner.accessToken, target.userId, 'unsuspend', {
      reason: 'Resolved with the customer',
    }).expect(200);
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: target.userId } })).status,
    ).toBe('active');
    expect(
      await admin.auditLogEntry.count({
        where: { action: 'account.unsuspended', targetId: target.userId },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: target.email, password: PASSWORD })
      .expect(200);
  });

  it('is refused to anyone who is not a Platform Owner', async () => {
    const outsider = await signUpAndSignIn('sus-outsider');
    const target = await signUpAndSignIn('sus-target-2');
    await act(outsider.accessToken, target.userId, 'suspend', { reason: 'x' }).expect(
      403,
    );
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: target.userId } })).status,
    ).toBe('active');
  });

  it('refuses the caller’s own account and another Platform Owner', async () => {
    const self = await act(platformOwner.accessToken, platformOwner.userId, 'suspend', {
      reason: 'x',
    }).expect(403);
    expect(self.body.error.messageKey).toBe('errors.platformUsers.cannotSuspendSelf');

    const other = await signUpAndSignIn('sus-other-po');
    await admin.user.update({
      where: { id: other.userId },
      data: { isPlatformOwner: true },
    });
    const refused = await act(platformOwner.accessToken, other.userId, 'suspend', {
      reason: 'x',
    }).expect(403);
    expect(refused.body.error.messageKey).toBe(
      'errors.platformUsers.cannotSuspendPlatformOwner',
    );
  });

  it('requires a reason to suspend', async () => {
    const target = await signUpAndSignIn('sus-noreason');
    await act(platformOwner.accessToken, target.userId, 'suspend', {}).expect(400);
    await act(platformOwner.accessToken, target.userId, 'suspend', { reason: '' }).expect(
      400,
    );
  });
});
