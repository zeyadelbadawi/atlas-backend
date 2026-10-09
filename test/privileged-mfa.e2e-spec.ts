/**
 * ATO review F11 — privileged management sign-ins get an emailed code on a
 * new browser even when the deployment's management flag is `off`.
 *
 *   PMFA-01  an ordinary account (no organization ownership) with the flag
 *            off signs straight in — unchanged
 *   PMFA-02  an organization owner on a new browser gets the code, no session
 *   PMFA-03  a Platform Owner on a new browser gets the code, no session
 *   PMFA-04  a remembered browser skips the code for a privileged account
 *   PMFA-05  an account with a confirmed authenticator app gets ONLY the
 *            authenticator step (the two are alternatives, never a stack)
 *   PMFA-06  a manager (organization member, not owner) is not privileged
 *   PMFA-07  past the enforcement date, a Platform Owner without an
 *            authenticator app is refused on platform routes (and can still
 *            reach their own security settings); with one, allowed
 *
 * The floor is `AUTH_PRIVILEGED_EMAIL_OTP_FLOOR` (production default
 * `new_device`); every other e2e suite runs with it `off`
 * (test/utils/e2e-env-defaults.ts), so it is set here before the app boots
 * and restored after.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { generate } from 'otplib';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { TRUST_COOKIE_NAME } from '../src/identity/services/trusted-device.service';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-pmfa';
const ENV_KEYS = [
  'AUTH_PRIVILEGED_EMAIL_OTP_FLOOR',
  'FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT',
  'PLATFORM_OWNER_TOTP_REQUIRED_FROM',
] as const;

describe('Privileged MFA floor (e2e) — ATO F11', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.AUTH_PRIVILEGED_EMAIL_OTP_FLOOR = 'new_device';
    // The deployment flag is OFF: the floor must hold regardless.
    process.env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT = 'off';
    // Already in force (PMFA-07).
    process.env.PLATFORM_OWNER_TOTP_REQUIRED_FROM = '2020-01-01T00:00:00.000Z';
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());

  async function register(label: string): Promise<{ email: string; userId: string }> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: 'PMFA Tester', email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  function signIn(email: string, trustCookie?: string) {
    const call = http().post('/auth/sign-in').send({ email, password: PASSWORD });
    return trustCookie ? call.set('Cookie', `${TRUST_COOKIE_NAME}=${trustCookie}`) : call;
  }

  async function latestCode(userId: string): Promise<string> {
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${userId} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const code = rows[0]?.values?.code;
    if (typeof code !== 'string') throw new Error('No OTP outbox row for that user.');
    return code;
  }

  function expectChallengeOnly(response: request.Response): void {
    expect(response.status).toBe(200);
    expect(response.body.emailOtpRequired).toBe(true);
    expect(response.body.accessToken).toBeUndefined();
  }

  it('PMFA-01 — an ordinary account signs straight in with the flag off', async () => {
    const { email } = await register('pmfa-01');
    const response = await signIn(email).expect(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.emailOtpRequired).toBeUndefined();
  });

  it('PMFA-02 — an organization owner on a new browser gets the emailed code and no session', async () => {
    const { email, userId } = await register('pmfa-02');
    await seedOrganizationWithOwner(admin, userId, 'pmfa-02-org');

    expectChallengeOnly(await signIn(email));
    expect(await admin.refreshToken.count({ where: { userId } })).toBe(0);
  });

  it('PMFA-03 — a Platform Owner on a new browser gets the emailed code and no session', async () => {
    const { email, userId } = await register('pmfa-03');
    await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });

    expectChallengeOnly(await signIn(email));
    expect(await admin.refreshToken.count({ where: { userId } })).toBe(0);
  });

  it('PMFA-04 — a remembered browser skips the code for a privileged account', async () => {
    const { email, userId } = await register('pmfa-04');
    await seedOrganizationWithOwner(admin, userId, 'pmfa-04-org');

    const challenge = await signIn(email).expect(200);
    expectChallengeOnly(challenge);
    const verified = await http()
      .post('/auth/otp/verify')
      .send({
        challengeId: challenge.body.challengeId,
        code: await latestCode(userId),
        rememberDevice: true,
        surface: 'management',
      })
      .expect(200);
    expect(verified.body.accessToken).toEqual(expect.any(String));
    const setCookie = (verified.headers['set-cookie'] as unknown as string[]) ?? [];
    const raw = setCookie.find((value) => value.startsWith(`${TRUST_COOKIE_NAME}=`));
    expect(raw).toBeDefined();
    const trust = decodeURIComponent(raw!.split(';')[0].slice(TRUST_COOKIE_NAME.length + 1));

    const again = await signIn(email, trust).expect(200);
    expect(again.body.accessToken).toEqual(expect.any(String));
    expect(again.body.emailOtpRequired).toBeUndefined();
  });

  it('PMFA-05 — a privileged account with an authenticator app gets only that step', async () => {
    const { email, userId } = await register('pmfa-05');
    // Enrol before ownership, while sign-in still issues a session directly.
    const session = await signIn(email).expect(200);
    const token = session.body.accessToken as string;
    const setup = await http()
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await http()
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: await generate({ secret: setup.body.secret }), password: PASSWORD })
      .expect(200);
    await seedOrganizationWithOwner(admin, userId, 'pmfa-05-org');

    const response = await signIn(email).expect(200);
    expect(response.body.twoFactorRequired).toBe(true);
    expect(response.body.emailOtpRequired).toBeUndefined();
    expect(response.body.accessToken).toBeUndefined();
  });

  it('PMFA-06 — a manager (organization member, not owner) is not privileged', async () => {
    const owner = await register('pmfa-06-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'pmfa-06-org');
    const manager = await register('pmfa-06-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');

    const response = await signIn(manager.email).expect(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it('PMFA-07 — past the enforcement date, platform routes need a Platform Owner\'s authenticator app', async () => {
    const { email, userId } = await register('pmfa-07');
    // Signed in (and enrolled) before becoming a Platform Owner, so the
    // session exists without the emailed-code step.
    const session = await signIn(email).expect(200);
    const token = session.body.accessToken as string;
    await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });

    const refused = await http()
      .get('/platform-academies')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.platformOwnerTwoFactorRequired');
    // Their own security settings stay reachable — that is where they enrol.
    await http().get('/auth/2fa/status').set('Authorization', `Bearer ${token}`).expect(200);

    const setup = await http()
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await http()
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: await generate({ secret: setup.body.secret }), password: PASSWORD })
      .expect(200);
    await http()
      .get('/platform-academies')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
