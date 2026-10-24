/**
 * B8 — a learner deletes their own account from an academy session (the
 * mobile app's "Delete account"), against real Postgres + Redis.
 *
 *   LDEL-01  a learner: allowed; emailed code → deleted; the account is
 *            anonymised, its sessions die, consents and push devices go
 *   LDEL-02  an organization owner on the academy surface: not allowed
 *   LDEL-03  academy staff (instructor) who is also a learner: not allowed
 *   LDEL-04  a management session: not allowed (that door is /users/me/delete)
 *   LDEL-05  a wrong code deletes nothing
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
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-ldel';
const BASE = 'learnerdeletion.test';
const ENV_KEYS = ['PLATFORM_BASE_DOMAIN', 'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY'] as const;

describe('Learner account deletion (e2e, B8)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      PLATFORM_BASE_DOMAIN: BASE,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'off',
    });
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function account(
    label: string,
    host = BASE,
    extra: Record<string, unknown> = {},
  ) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', host)
      .send({ name: label, email, password: PASSWORD, ...extra })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    // The deletion code goes to a verified address only.
    await admin.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    return { email, userId: user.id };
  }

  async function academy(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: a.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.custom.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    return { id: a.id, host, owner };
  }

  async function academySession(email: string, a: { id: string; host: string }) {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function requestCode(token: string, host: string) {
    const issued = await http()
      .post('/users/me/learner-deletion/request')
      .set('Host', host)
      .set(bearer(token))
      .expect(200);
    const challengeId = issued.body.challengeId as string;
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.deletion_code', entityId: challengeId },
    });
    return { challengeId, code: (row.values as { code: string }).code };
  }

  it('LDEL-01 — a learner deletes their account; everything personal goes', async () => {
    const a = await academy('ld01');
    const learner = await account('ld01-l', a.host, {
      academyId: a.id,
      consents: {
        source: 'android',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        ageConfirmed: true,
      },
    });
    const token = await academySession(learner.email, a);
    await http()
      .put('/users/me/push-devices')
      .set('Host', a.host)
      .set(bearer(token))
      .send({
        token: `fcm-${Date.now()}-ld01-token`,
        platform: 'android',
        appVersion: '1.0.0',
        locale: 'en',
      })
      .expect(200);

    const availability = await http()
      .get('/users/me/learner-deletion')
      .set('Host', a.host)
      .set(bearer(token))
      .expect(200);
    expect(availability.body).toEqual({ allowed: true });

    const { challengeId, code } = await requestCode(token, a.host);
    const res = await http()
      .post('/users/me/learner-deletion')
      .set('Host', a.host)
      .set(bearer(token))
      .send({ confirm: true, challengeId, code })
      .expect(200);
    expect(res.body).toMatchObject({ deleted: true, academiesArchived: 0 });

    const user = await admin.user.findUniqueOrThrow({ where: { id: learner.userId } });
    expect(user.email).not.toBe(learner.email);
    expect(await admin.userConsent.count({ where: { userId: learner.userId } })).toBe(0);
    expect(await admin.pushDevice.count({ where: { userId: learner.userId } })).toBe(0);
    await http().get('/users/me').set('Host', a.host).set(bearer(token)).expect(401);
  });

  it('LDEL-02 — an organization owner is sent to the management flow', async () => {
    const a = await academy('ld02');
    const token = await academySession(a.owner.email, a);
    const availability = await http()
      .get('/users/me/learner-deletion')
      .set('Host', a.host)
      .set(bearer(token))
      .expect(200);
    expect(availability.body).toEqual({ allowed: false });
    const refused = await http()
      .post('/users/me/learner-deletion/request')
      .set('Host', a.host)
      .set(bearer(token))
      .expect(403);
    expect(refused.body.error.messageKey).toBe(
      'errors.account.learnerDeletionNotAvailable',
    );
  });

  it('LDEL-03 — academy staff who also learn are not allowed', async () => {
    const a = await academy('ld03');
    const staff = await account('ld03-staff', a.host, { academyId: a.id });
    await seedAcademyMember(admin, a.id, staff.userId, 'instructor');
    const token = await academySession(staff.email, a);
    await http()
      .post('/users/me/learner-deletion/request')
      .set('Host', a.host)
      .set(bearer(token))
      .expect(403);
  });

  it('LDEL-04 — a management session cannot use the learner door', async () => {
    const owner = await account('ld04');
    const session = await http()
      .post('/auth/sign-in')
      .set('Host', BASE)
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);
    await http()
      .post('/users/me/learner-deletion/request')
      .set('Host', BASE)
      .set(bearer(session.body.accessToken))
      .expect(403);
  });

  it('LDEL-05 — a wrong code deletes nothing', async () => {
    const a = await academy('ld05');
    const learner = await account('ld05-l', a.host, { academyId: a.id });
    const token = await academySession(learner.email, a);
    const { challengeId, code } = await requestCode(token, a.host);
    const wrong = code === '000000' ? '111111' : '000000';
    await http()
      .post('/users/me/learner-deletion')
      .set('Host', a.host)
      .set(bearer(token))
      .send({ confirm: true, challengeId, code: wrong })
      .expect((r) => expect([400, 401, 403]).toContain(r.status));
    const user = await admin.user.findUniqueOrThrow({ where: { id: learner.userId } });
    expect(user.email).toBe(learner.email);
  });
});
