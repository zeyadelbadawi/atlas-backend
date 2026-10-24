/**
 * B3 — App Store / Google Play review accounts (docs/mobile/MOBILE_APP_BACKEND.md).
 *
 * With the academy's emailed code ALWAYS required, a listed review account
 * signs in to the configured demo academy without it — and nothing else
 * changes:
 *
 *   REVIEW-01  listed account, demo academy → session, no code; audited
 *   REVIEW-02  listed account, another academy → code required
 *   REVIEW-03  unlisted account, demo academy → code required
 *   REVIEW-04  nothing configured → code required (the default)
 *   REVIEW-05  a listed account that owns an organization → code required
 *   REVIEW-06  no code required anyway → no bypass audit row
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { EmailOtpService } from '../src/identity/services/email-otp.service';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-review';
const BASE = 'appreview.test';
const ENV_KEYS = ['PLATFORM_BASE_DOMAIN', 'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY'] as const;

describe('App review access (e2e, B3)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let review: { emails?: string; academyId?: string } = {};

  beforeAll(async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      PLATFORM_BASE_DOMAIN: BASE,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'always',
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

    // The two review variables, per test; every other key as configured.
    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string, ...rest: unknown[]) => {
      if (key === 'APP_REVIEW_EMAILS') return review.emails;
      if (key === 'APP_REVIEW_ACADEMY_ID') return review.academyId;
      return (original as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
    review = {};
  });

  const http = () => request(app.getHttpServer());

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

  async function learner(label: string, a: { id: string; host: string }) {
    return account(label, a.host, { academyId: a.id });
  }

  function signIn(email: string, a: { id: string; host: string }) {
    return http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id });
  }

  it('REVIEW-01 — a listed account signs in to the demo academy without the code, audited', async () => {
    const demo = await academy('r01');
    const reviewer = await learner('r01-reviewer', demo);
    review = {
      emails: `someone@else.test, ${reviewer.email.toUpperCase()}`,
      academyId: demo.id,
    };

    const res = await signIn(reviewer.email, demo).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.emailOtpRequired).toBeUndefined();

    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'auth.otp.app_review_bypass', actorUserId: reviewer.userId },
    });
    expect(audit).not.toBeNull();
  });

  it('REVIEW-02 — the same account on another academy still needs the code', async () => {
    const demo = await academy('r02a');
    const other = await academy('r02b');
    const reviewer = await learner('r02-reviewer', other);
    review = { emails: reviewer.email, academyId: demo.id };
    const res = await signIn(reviewer.email, other).expect(200);
    expect(res.body.emailOtpRequired).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('REVIEW-03 — an unlisted account on the demo academy still needs the code', async () => {
    const demo = await academy('r03');
    const someone = await learner('r03-learner', demo);
    review = { emails: 'reviewer@example.test', academyId: demo.id };
    const res = await signIn(someone.email, demo).expect(200);
    expect(res.body.emailOtpRequired).toBe(true);
  });

  it('REVIEW-04 — with nothing configured, everyone needs the code', async () => {
    const demo = await academy('r04');
    const reviewer = await learner('r04-reviewer', demo);
    const res = await signIn(reviewer.email, demo).expect(200);
    expect(res.body.emailOtpRequired).toBe(true);
  });

  it('REVIEW-05 — a listed account that owns an organization still needs the code', async () => {
    const demo = await academy('r05');
    review = { emails: demo.owner.email, academyId: demo.id };
    const res = await signIn(demo.owner.email, demo).expect(200);
    expect(res.body.emailOtpRequired).toBe(true);
  });

  it('REVIEW-06 — when no code would be asked anyway, nothing is recorded as bypassed', async () => {
    const demo = await academy('r06');
    const reviewer = await learner('r06-reviewer', demo);
    review = { emails: reviewer.email, academyId: demo.id };
    jest.spyOn(app.get(EmailOtpService), 'isRequired').mockResolvedValueOnce(false);
    const res = await signIn(reviewer.email, demo).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(
      await admin.auditLogEntry.count({
        where: { action: 'auth.otp.app_review_bypass', actorUserId: reviewer.userId },
      }),
    ).toBe(0);
  });
});
