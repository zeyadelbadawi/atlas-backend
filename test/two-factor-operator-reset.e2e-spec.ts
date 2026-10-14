/**
 * B0-OC-03 — the audited break-glass second-factor reset
 * (`TwoFactorService.resetByOperator`, run by `src/scripts/reset-two-factor.ts`)
 * and the audit rows for self-service enable/disable (IAM-9).
 *
 * The reset must weaken nothing: only a Platform Owner may run it, never
 * on themselves, with a reason; it removes exactly the target's own
 * second-factor rows, ends every session of the target, and writes one
 * audit row naming the operator. Real HTTP, real Postgres/Redis, real TOTP.
 */
import {
  ForbiddenException,
  INestApplication,
  BadRequestException,
} from '@nestjs/common';
import request from 'supertest';
import { generate } from 'otplib';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail, waitFor } from './utils/test-app';
import type { StubEmailProvider } from '../src/identity/services/stub-email.provider';
import { createAdminPrisma } from './utils/db-admin';
import { TwoFactorService } from '../src/identity/services/two-factor.service';

jest.setTimeout(30000);

const PASSWORD = 'correct-horse-battery';

describe('Two-factor operator reset (e2e) — B0-OC-03', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let twoFactor: TwoFactorService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    twoFactor = app.get(TwoFactorService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
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
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function enrol(label: string) {
    const user = await signUp(label);
    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    const code = await generate({ secret: setup.body.secret as string });
    await request(app.getHttpServer())
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ token: code, password: PASSWORD })
      .expect(200);
    return user;
  }

  async function platformOwner(label: string) {
    const user = await signUp(label);
    await admin.user.update({
      where: { id: user.userId },
      data: { isPlatformOwner: true },
    });
    return user;
  }

  const factorRows = async (userId: string) => ({
    factor: await admin.userTwoFactor.count({ where: { userId } }),
    codes: await admin.twoFactorRecoveryCode.count({ where: { userId } }),
  });

  it('records self-service enrolment in the audit log', async () => {
    const user = await enrol('oc03-self');
    const rows = await admin.auditLogEntry.count({
      where: { action: 'auth.two_factor.enabled', targetId: user.userId },
    });
    expect(rows).toBe(1);
  });

  it('refuses an operator who is not a Platform Owner, and changes nothing', async () => {
    const operator = await signUp('oc03-notpo');
    const target = await enrol('oc03-target-a');
    await expect(
      twoFactor.resetByOperator(operator.userId, target.userId, 'lost phone'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await factorRows(target.userId)).toEqual({ factor: 1, codes: 10 });
  });

  it('refuses a Platform Owner resetting their own factor', async () => {
    const operator = await platformOwner('oc03-self-po');
    await expect(
      twoFactor.resetByOperator(operator.userId, operator.userId, 'lost phone'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a reset without a reason', async () => {
    const operator = await platformOwner('oc03-noreason-po');
    const target = await enrol('oc03-target-b');
    await expect(
      twoFactor.resetByOperator(operator.userId, target.userId, '   '),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await factorRows(target.userId)).toEqual({ factor: 1, codes: 10 });
  });

  it('removes only the target’s factor, ends their sessions and writes one audit row', async () => {
    const operator = await platformOwner('oc03-po');
    const target = await enrol('oc03-target-c');
    const bystander = await enrol('oc03-bystander');

    const result = await twoFactor.resetByOperator(
      operator.userId,
      target.userId,
      'ticket 123: lost phone and recovery codes',
    );

    expect(result.hadTwoFactor).toBe(true);
    expect(result.sessionsRevoked).toBeGreaterThan(0);
    expect(await factorRows(target.userId)).toEqual({ factor: 0, codes: 0 });
    expect(await factorRows(bystander.userId)).toEqual({ factor: 1, codes: 10 });
    expect(
      await admin.refreshToken.count({
        where: { userId: target.userId, revokedAt: null },
      }),
    ).toBe(0);

    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'auth.two_factor.reset_by_operator', targetId: target.userId },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(operator.userId);

    // The old access token no longer works, and the password alone signs in
    // again (no second factor left to ask for) — the password is still needed.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${target.token}`)
      .expect(401);
    const again = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: target.email, password: PASSWORD })
      .expect(200);
    expect(again.body.twoFactorRequired).toBeFalsy();
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: target.email, password: 'not-the-password' })
      .expect(401);
  });
});

/**
 * B0-OC-04 — a Google-only account (no password) cannot confirm TOTP,
 * because confirmation needs the current password; "Forgot password?"
 * sets a first password, after which enrolment works.
 */
describe('Google-only account and TOTP enrolment (e2e) — B0-OC-04', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let stubEmailProvider: StubEmailProvider;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    stubEmailProvider = testApp.stubEmailProvider;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  it('refuses TOTP confirmation without a password, and succeeds after a password reset', async () => {
    const email = uniqueTestEmail('oc04-google-only');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'oc04', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const userId = signIn.body.user.id as string;
    const token = signIn.body.accessToken as string;

    // Make it a Google-only account: verified, a Google identity, no password.
    await admin.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    await admin.userAuthIdentity.create({
      data: {
        userId,
        provider: 'google',
        providerSubject: `oc04-${userId}`,
        emailAtLink: email,
      },
    });
    await admin.userCredential.delete({ where: { userId } });

    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const secret = setup.body.secret as string;
    const refused = await request(app.getHttpServer())
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: await generate({ secret }), password: 'any-password-at-all' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.setPasswordBeforeTwoFactor');
    expect(
      await admin.userTwoFactor.count({ where: { userId, confirmedAt: { not: null } } }),
    ).toBe(0);

    // "Forgot password?" sets a first password for the Google-only account.
    await request(app.getHttpServer())
      .post('/auth/password-reset/request')
      .send({ email })
      .expect(200);
    const raw = await waitFor(() => stubEmailProvider.peekLastPasswordResetToken(email));
    const newPassword = 'first-password-after-google-1';
    await request(app.getHttpServer())
      .post('/auth/password-reset/confirm')
      .send({ token: raw, newPassword })
      .expect(200);
    expect(await admin.userCredential.count({ where: { userId } })).toBe(1);
    // The Google sign-in survives: the address was already proven.
    expect(await admin.userAuthIdentity.count({ where: { userId } })).toBe(1);

    const again = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: newPassword })
      .expect(200);
    const freshToken = again.body.accessToken as string;
    const setup2 = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${freshToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({
        token: await generate({ secret: setup2.body.secret as string }),
        password: newPassword,
      })
      .expect(200);
    expect(
      await admin.userTwoFactor.count({ where: { userId, confirmedAt: { not: null } } }),
    ).toBe(1);
  });
});
