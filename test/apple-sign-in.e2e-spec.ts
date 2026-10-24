/**
 * B2 — Sign in with Apple for the mobile app, against real Postgres + Redis.
 * The identity token's cryptography is unit-tested
 * (`apple-id-token.verifier.spec.ts`); here the verifier's result is stubbed
 * and everything after it is real.
 *
 *   APPLE-01  off → 404
 *   APPLE-02  a new address → create_account → one account (phone, consents,
 *             learner row, Apple identity, sealed token) and an Apple session
 *   APPLE-03  the same Apple ID again → signs straight in
 *   APPLE-04  an existing password account → link_required; a wrong password
 *             keeps the step open; the right one links, emails a notice, signs in
 *   APPLE-05  a step secret is single-use and bound to its host
 *   APPLE-06  a bad token → 401; an academy id that is not the host's → 403
 *   APPLE-07  account deletion revokes and erases the Apple data
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
import { AppleAuthService } from '../src/identity/apple/apple-auth.service';
import { AppleTokenService } from '../src/identity/apple/apple-token.service';
import { AppleTokenError } from '../src/identity/apple/apple-id-token.verifier';
import type { AppleIdentityClaims } from '../src/identity/apple/apple-id-token.verifier';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-apple';
const BASE = 'applesignin.test';
const ENV_KEYS = ['PLATFORM_BASE_DOMAIN', 'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY'] as const;
const CONSENTS = {
  source: 'ios',
  termsVersion: 'terms-1',
  privacyVersion: 'privacy-1',
  ageConfirmed: true,
};

describe('Sign in with Apple (e2e, B2)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let appleMode: string | undefined = 'on';
  let claims: AppleIdentityClaims | Error;
  let revokeSpy: jest.SpyInstance;
  let phoneSeq = 0;

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

    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string, ...rest: unknown[]) => {
      if (key === 'FLAG_AUTH_APPLE_MODE') return appleMode;
      if (key === 'APPLE_CLIENT_IDS') return 'com.atlas.learner';
      return (original as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never);

    const service = app.get(AppleAuthService);
    const verifier = (
      service as unknown as { verifier: { verify: () => Promise<unknown> } }
    ).verifier;
    jest.spyOn(verifier, 'verify').mockImplementation(async () => {
      if (claims instanceof Error) throw claims;
      return claims;
    });
    const tokens = app.get(AppleTokenService);
    jest.spyOn(tokens, 'sealedTokenFor').mockResolvedValue('v1.sealed-for-test');
    revokeSpy = jest.spyOn(tokens, 'revokeBeforeDeletion');
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
    appleMode = 'on';
  });

  const http = () => request(app.getHttpServer());

  async function academy(label: string) {
    const email = uniqueTestEmail(`${label}-owner`);
    await http()
      .post('/auth/register')
      .set('Host', BASE)
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const owner = await admin.user.findUniqueOrThrow({ where: { email } });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: a.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, a.id, owner.id, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.custom.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    return { id: a.id, host };
  }

  const appleClaims = (
    email: string,
    sub = `sub.${Math.random()}`,
  ): AppleIdentityClaims => ({
    subject: sub,
    email,
    isPrivateEmail: false,
    clientId: 'com.atlas.learner',
  });

  function native(a: { id: string; host: string }, extra: Record<string, unknown> = {}) {
    return http()
      .post('/auth/apple/native')
      .set('Host', a.host)
      .send({
        identityToken: 'header.payload.signature-placeholder',
        rawNonce: 'raw-nonce-0123456789abcdef',
        academyId: a.id,
        givenName: 'Sara',
        familyName: 'Ali',
        ...extra,
      });
  }

  const uniquePhone = () =>
    `015${String((Date.now() + phoneSeq++) % 100000000).padStart(8, '0')}`;

  it('APPLE-01 — off means 404', async () => {
    const a = await academy('ap01');
    appleMode = undefined;
    claims = appleClaims(uniqueTestEmail('ap01'));
    await native(a).expect(404);
  });

  it('APPLE-02/03 — create the account, then sign straight in next time', async () => {
    const a = await academy('ap02');
    const email = uniqueTestEmail('ap02');
    claims = appleClaims(email, 'sub.ap02');

    const step = await native(a).expect(200);
    expect(step.body).toMatchObject({
      appleStep: 'create_account',
      email,
      name: 'Sara Ali',
    });

    const created = await http()
      .post('/auth/apple/create-account')
      .set('Host', a.host)
      .send({
        pending: step.body.pending,
        name: 'Sara Ali',
        phoneNumber: uniquePhone(),
        phoneCountry: 'EG',
        consents: CONSENTS,
      })
      .expect(200);
    expect(created.body).toMatchObject({
      authMethod: 'apple',
      accessToken: expect.any(String),
    });

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await admin.userAuthIdentity.findFirst({
        where: { userId: user.id, provider: 'apple' },
      }),
    ).toMatchObject({ providerSubject: 'sub.ap02' });
    expect(await admin.userConsent.count({ where: { userId: user.id } })).toBe(3);
    expect(
      await admin.userPhone.findUnique({ where: { userId: user.id } }),
    ).not.toBeNull();
    expect(
      await admin.academyStudent.count({ where: { userId: user.id, academyId: a.id } }),
    ).toBe(1);
    expect(
      await admin.appleRefreshToken.findUnique({ where: { userId: user.id } }),
    ).toMatchObject({
      sealedToken: 'v1.sealed-for-test',
      clientId: 'com.atlas.learner',
    });

    const again = await native(a).expect(200);
    expect(again.body).toMatchObject({
      authMethod: 'apple',
      accessToken: expect.any(String),
    });
    expect(again.body.appleStep).toBeUndefined();
  });

  it('APPLE-04 — an existing account links with its password', async () => {
    const a = await academy('ap04');
    const email = uniqueTestEmail('ap04');
    await http()
      .post('/auth/register')
      .set('Host', a.host)
      .send({ name: 'Existing', email, password: PASSWORD, academyId: a.id })
      .expect(201);
    claims = appleClaims(email, 'sub.ap04');

    const step = await native(a).expect(200);
    expect(step.body).toMatchObject({ appleStep: 'link_required', email });
    expect(step.body.name).toBeUndefined();

    await http()
      .post('/auth/apple/link')
      .set('Host', a.host)
      .send({ pending: step.body.pending, password: 'wrong-password-123' })
      .expect(401);
    const linked = await http()
      .post('/auth/apple/link')
      .set('Host', a.host)
      .send({ pending: step.body.pending, password: PASSWORD })
      .expect(200);
    expect(linked.body).toMatchObject({ authMethod: 'apple' });

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(
      await admin.userAuthIdentity.count({
        where: { userId: user.id, provider: 'apple' },
      }),
    ).toBe(1);
    expect(
      await admin.communicationOutbox.count({
        where: { key: 'auth.identity.apple_linked', recipientUserId: user.id },
      }),
    ).toBe(1);
  });

  it('APPLE-05 — a step secret is single-use and bound to its host', async () => {
    const a = await academy('ap05a');
    const b = await academy('ap05b');
    claims = appleClaims(uniqueTestEmail('ap05'));
    const step = await native(a).expect(200);
    const body = {
      pending: step.body.pending,
      name: 'X',
      phoneNumber: uniquePhone(),
      phoneCountry: 'EG',
      consents: CONSENTS,
    };
    await http()
      .post('/auth/apple/create-account')
      .set('Host', b.host)
      .send(body)
      .expect(401);
    // The other host's attempt spent it.
    await http()
      .post('/auth/apple/create-account')
      .set('Host', a.host)
      .send(body)
      .expect(401);
  });

  it('APPLE-06 — a bad token is 401; another academy id is 403', async () => {
    const a = await academy('ap06a');
    const b = await academy('ap06b');
    claims = new AppleTokenError('invalid_token', 'bad signature');
    await native(a).expect(401);
    claims = appleClaims(uniqueTestEmail('ap06'));
    await native(a, { academyId: b.id }).expect(403);
  });

  it('APPLE-07 — deleting the account revokes and erases the Apple data', async () => {
    const a = await academy('ap07');
    const email = uniqueTestEmail('ap07');
    claims = appleClaims(email, 'sub.ap07');
    const step = await native(a).expect(200);
    const session = await http()
      .post('/auth/apple/create-account')
      .set('Host', a.host)
      .send({
        pending: step.body.pending,
        name: 'Del',
        phoneNumber: uniquePhone(),
        phoneCountry: 'EG',
        consents: CONSENTS,
      })
      .expect(200);
    const token = session.body.accessToken as string;
    const user = await admin.user.findUniqueOrThrow({ where: { email } });

    const issued = await http()
      .post('/users/me/learner-deletion/request')
      .set('Host', a.host)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { key: 'auth.account.deletion_code', entityId: issued.body.challengeId },
    });
    revokeSpy.mockClear();
    await http()
      .post('/users/me/learner-deletion')
      .set('Host', a.host)
      .set('Authorization', `Bearer ${token}`)
      .send({
        confirm: true,
        challengeId: issued.body.challengeId,
        code: (row.values as { code: string }).code,
      })
      .expect(200);
    expect(revokeSpy).toHaveBeenCalledWith(user.id);
    expect(await admin.appleRefreshToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await admin.userAuthIdentity.count({ where: { userId: user.id } })).toBe(0);
  });
});
