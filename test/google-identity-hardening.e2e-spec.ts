/**
 * Google Identity — Phase 4 hardening (docs/GOOGLE_AUTH_PHASE_4_VERIFICATION.md).
 *
 * The adversarial and cross-surface cases the flow suite
 * (`google-identity.e2e-spec.ts`) does not reach, run against the same
 * local fake of Google (`utils/fake-google-oidc.ts`) but with the
 * production-shaped settings they need:
 *  - a real `PLATFORM_BASE_DOMAIN`, so "only the platform host is a
 *    callback host" is tested against `www.`, academy subdomains and
 *    custom domains rather than against `localhost`;
 *  - the emailed code (A6) on BOTH surfaces, so trusted devices can be
 *    shown to stay per-surface and per-academy through Google;
 *  - a TOTP-enrolled account, so Google is shown never to skip it.
 */
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { generate } from 'otplib';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { FakeGoogleOidc } from './utils/fake-google-oidc';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';
import { hashFlowSecret } from '../src/identity/google/google-flow.util';
import { TRUST_COOKIE_NAME } from '../src/identity/services/trusted-device.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-gid4';
const CLIENT_ID = 'atlas-p4-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'atlas-p4-client-secret-never-logged';
/** The platform (management) host: `PLATFORM_BASE_DOMAIN` itself. */
const BASE = 'gidp4.test';
const REDIRECT_URI = `http://${BASE}/auth/google/callback`;

const ENV_KEYS = [
  'PLATFORM_BASE_DOMAIN',
  'FLAG_AUTH_GOOGLE_MODE',
  'FLAG_AUTH_GOOGLE_ACADEMY_IDS',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_OIDC_ISSUER',
  'GOOGLE_OIDC_AUTHORIZATION_ENDPOINT',
  'GOOGLE_OIDC_TOKEN_ENDPOINT',
  'GOOGLE_OIDC_JWKS_URI',
  'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY',
  'FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT',
] as const;

/** Closed vocabularies of `atlas_google_auth_total` (google-auth-metrics.ts). */
const STAGES = [
  'authorize',
  'callback',
  'complete',
  'link',
  'create',
  'activate',
  'unlink',
];
const RESULTS = [
  'started',
  'cancelled',
  'provider_error',
  'invalid_state',
  'invalid_token',
  'unverified_email',
  'existing_identity',
  'link_required',
  'create_account',
  'activate_invited',
  'refused',
  'rate_limited',
  'disabled',
  'linked',
  'created',
  'activated',
  'unlinked',
  'conflict',
  'invalid_credentials',
];

describe('Google Identity — Phase 4 hardening (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let google: FakeGoogleOidc;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    google = new FakeGoogleOidc({
      issuer: 'http://fake-google.test',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
    });
    await google.start();
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, {
      PLATFORM_BASE_DOMAIN: BASE,
      FLAG_AUTH_GOOGLE_MODE: 'on',
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_OIDC_ISSUER: 'http://fake-google.test',
      GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: 'http://fake-google.test/auth',
      GOOGLE_OIDC_TOKEN_ENDPOINT: `${google.baseUrl}/token`,
      GOOGLE_OIDC_JWKS_URI: `${google.baseUrl}/jwks`,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'new_device',
      FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT: 'new_device',
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
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
    await google.stop();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ------------------------------------------------------------------
  // fixtures
  // ------------------------------------------------------------------

  const http = () => request(app.getHttpServer());
  const newSub = () => `g4-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cookies = (...parts: (string | undefined)[]) =>
    parts.filter((p): p is string => !!p).join('; ');

  interface Academy {
    readonly id: string;
    readonly host: string;
  }

  async function register(label: string, host = BASE, academyId?: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', host)
      .send({
        name: label,
        email,
        password: PASSWORD,
        ...(academyId ? { academyId } : {}),
      })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function academy(label: string): Promise<Academy> {
    const owner = await register(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: a.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.custom.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    return { id: a.id, host };
  }

  async function linkGoogle(userId: string, sub: string, email: string) {
    await admin.userAuthIdentity.create({
      data: { userId, provider: 'google', providerSubject: sub, emailAtLink: email },
    });
  }

  function binderFrom(res: request.Response): string {
    const c = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((v) => v.startsWith('atlas_google_binder='));
    if (!c) throw new Error('no binder cookie');
    return c.split(';')[0];
  }

  function trustFrom(res: request.Response): string {
    const c = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((v) => v.startsWith(`${TRUST_COOKIE_NAME}=`));
    if (!c) throw new Error('no trust cookie');
    return c.split(';')[0];
  }

  const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';
  const fragmentOf = (location: string) =>
    new URLSearchParams(location.split('#')[1] ?? '');

  async function authorize(
    host: string,
    body: Record<string, unknown> = { intent: 'sign_in' },
    bearer?: string,
  ) {
    const req = http().post('/auth/google/authorize').set('Host', host).send(body);
    const res = await (
      bearer ? req.set('Authorization', `Bearer ${bearer}`) : req
    ).expect(200);
    return {
      authorizationUrl: res.body.authorizationUrl as string,
      binder: binderFrom(res),
    };
  }

  const callback = (query: Record<string, string>, host = BASE) =>
    http().get('/auth/google/callback').set('Host', host).query(query);

  async function throughGoogle(
    host: string,
    signIn: Parameters<FakeGoogleOidc['approve']>[1],
    body?: Record<string, unknown>,
    bearer?: string,
  ) {
    const started = await authorize(host, body, bearer);
    const { code, state } = google.approve(started.authorizationUrl, signIn);
    const res = await callback({ code, state }).expect(303);
    return {
      ...started,
      state,
      code,
      handoff: fragmentOf(res.headers.location).get('h') ?? '',
      location: res.headers.location as string,
    };
  }

  const complete = (host: string, handoff: string, cookie?: string) => {
    const req = http().post('/auth/google/complete').set('Host', host).send({ handoff });
    return cookie ? req.set('Cookie', cookie) : req;
  };

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

  /** Finishes an emailed-code challenge on `host`; returns the session response. */
  async function finishCode(
    host: string,
    userId: string,
    challengeId: string,
    scope: { surface: 'management' | 'academy'; academyId?: string },
    rememberDevice = false,
  ) {
    return http()
      .post('/auth/otp/verify')
      .set('Host', host)
      .send({ challengeId, code: await latestCode(userId), rememberDevice, ...scope })
      .expect(200);
  }

  /** A management session by password (completing the management code). */
  async function passwordSession(email: string, userId: string) {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', BASE)
      .send({ email, password: PASSWORD, surface: 'management' })
      .expect(200);
    if (res.body.accessToken) return res.body.accessToken as string;
    const done = await finishCode(BASE, userId, res.body.challengeId, {
      surface: 'management',
    });
    return done.body.accessToken as string;
  }

  const sessionRows = (userId: string) => admin.refreshToken.count({ where: { userId } });

  // ==================================================================
  // The pipeline: Google replaces the password only
  // ==================================================================

  describe('GID4-PIPE — Google never skips TOTP or the emailed code', () => {
    it('GID4-PIPE-01 — a TOTP-enrolled account: challenge first, no session until the TOTP code (which replaces the email code, as for a password); session says google', async () => {
      const staff = await register('p4-totp');
      const token = await passwordSession(staff.email, staff.userId);
      const setup = await http()
        .post('/auth/2fa/setup')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const secret = setup.body.secret as string;
      await http()
        .post('/auth/2fa/confirm')
        .set('Authorization', `Bearer ${token}`)
        .send({ token: await generate({ secret }) })
        .expect(200);
      const sub = newSub();
      await linkGoogle(staff.userId, sub, staff.email);

      const before = await sessionRows(staff.userId);
      const flow = await throughGoogle(BASE, { sub, email: staff.email });
      const challenge = await complete(BASE, flow.handoff, flow.binder).expect(200);
      expect(challenge.body).toMatchObject({ twoFactorRequired: true });
      expect(challenge.body.accessToken).toBeUndefined();
      expect(await sessionRows(staff.userId)).toBe(before);

      const next = await http()
        .post('/auth/2fa/verify')
        .set('Host', BASE)
        .send({
          challengeId: challenge.body.challengeId,
          token: await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }),
          surface: 'management',
        })
        .expect(200);
      // TOTP and the emailed code are alternatives, never a stack (§12):
      // the authenticator completes the sign-in, on the Google method.
      expect(next.body.emailOtpRequired).toBeUndefined();
      expect(next.body.authMethod).toBe('google');
      expect(await sessionRows(staff.userId)).toBe(before + 1);
      const row = await admin.refreshToken.findFirstOrThrow({
        where: { userId: staff.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.authMethod).toBe('google');
    });

    it('GID4-PIPE-02 — a suspended linked account is refused before any challenge or session', async () => {
      const staff = await register('p4-susp');
      const sub = newSub();
      await linkGoogle(staff.userId, sub, staff.email);
      await admin.user.update({
        where: { id: staff.userId },
        data: { status: 'suspended' },
      });
      const before = await sessionRows(staff.userId);
      const flow = await throughGoogle(BASE, { sub, email: staff.email });
      const res = await complete(BASE, flow.handoff, flow.binder).expect(403);
      expect(res.body.error.messageKey).toBe('errors.auth.accountSuspended');
      expect(await sessionRows(staff.userId)).toBe(before);
    });
  });

  // ==================================================================
  // A6 — trusted devices stay per surface and per academy through Google
  // ==================================================================

  describe('GID4-A6 — trusted devices through Google', () => {
    it('GID4-A6-01 — remembered on academy A: A skips the code; B and management still ask; forgetting A brings the code back', async () => {
      const a = await academy('p4-a6a');
      const b = await academy('p4-a6b');
      const person = await register('p4-a6', a.host, a.id);
      await admin.academyStudent.create({
        data: { academyId: b.id, userId: person.userId },
      });
      // Staff at A too, so a management session is possible at all.
      await seedAcademyMember(admin, a.id, person.userId, 'instructor');
      const sub = newSub();
      await linkGoogle(person.userId, sub, person.email);

      const onA = { surface: 'academy' as const, academyId: a.id };
      const first = await throughGoogle(a.host, { sub, email: person.email });
      const challengeA = await complete(a.host, first.handoff, first.binder).expect(200);
      expect(challengeA.body.emailOtpRequired).toBe(true);
      // The code asked for on A cannot be finished on B.
      await http()
        .post('/auth/otp/verify')
        .set('Host', b.host)
        .send({
          challengeId: challengeA.body.challengeId,
          code: await latestCode(person.userId),
          rememberDevice: true,
          surface: 'academy',
          academyId: b.id,
        })
        .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      const verified = await finishCode(
        a.host,
        person.userId,
        challengeA.body.challengeId,
        onA,
        true,
      );
      const trustA = trustFrom(verified);

      // A, same browser: straight in, via Google.
      const again = await throughGoogle(a.host, { sub, email: person.email });
      const inA = await complete(
        a.host,
        again.handoff,
        cookies(again.binder, trustA),
      ).expect(200);
      expect(inA.body.accessToken).toEqual(expect.any(String));
      expect(inA.body.authMethod).toBe('google');

      // B, same browser and cookie: asked.
      const onB = await throughGoogle(b.host, { sub, email: person.email });
      const challengeB = await complete(
        b.host,
        onB.handoff,
        cookies(onB.binder, trustA),
      ).expect(200);
      expect(challengeB.body.emailOtpRequired).toBe(true);
      expect(challengeB.body.accessToken).toBeUndefined();

      // Management, same cookie: asked.
      const onM = await throughGoogle(BASE, { sub, email: person.email });
      const challengeM = await complete(
        BASE,
        onM.handoff,
        cookies(onM.binder, trustA),
      ).expect(200);
      expect(challengeM.body.emailOtpRequired).toBe(true);

      // Remembered on management does not trust A either.
      const mVerified = await finishCode(
        BASE,
        person.userId,
        challengeM.body.challengeId,
        { surface: 'management' },
        true,
      );
      const trustM = trustFrom(mVerified);
      const aWithM = await throughGoogle(a.host, { sub, email: person.email });
      expect(
        (
          await complete(a.host, aWithM.handoff, cookies(aWithM.binder, trustM)).expect(
            200,
          )
        ).body.emailOtpRequired,
      ).toBe(true);

      // Forget A's device → A asks again.
      const list = await http()
        .get('/auth/trusted-devices')
        .set('Host', a.host)
        .set('Authorization', `Bearer ${inA.body.accessToken}`)
        .expect(200);
      const deviceA = (list.body.items as { id: string; surface: string }[]).find(
        (d) => d.surface === 'academy',
      );
      expect(deviceA).toBeDefined();
      await http()
        .delete(`/auth/trusted-devices/${deviceA!.id}`)
        .set('Host', a.host)
        .set('Authorization', `Bearer ${inA.body.accessToken}`)
        .expect(204);
      const afterForget = await throughGoogle(a.host, { sub, email: person.email });
      expect(
        (
          await complete(
            a.host,
            afterForget.handoff,
            cookies(afterForget.binder, trustA),
          ).expect(200)
        ).body.emailOtpRequired,
      ).toBe(true);
    });
  });

  // ==================================================================
  // Hosts and origins
  // ==================================================================

  describe('GID4-HOST — only the platform host is the callback; flows stay on their origin', () => {
    it('GID4-HOST-01 — www., an academy subdomain and a custom domain are refused (404) without spending the state; the platform host redirects to the ORIGIN', async () => {
      const a = await academy('p4-cb');
      const started = await authorize(a.host);
      const { code, state } = google.approve(started.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('p4-cb'),
      });
      for (const host of [`www.${BASE}`, `someacademy.${BASE}`, a.host]) {
        await callback({ code, state }, host).expect(404);
      }
      const ok = await callback({ code, state }, BASE).expect(303);
      expect(ok.headers.location).toMatch(
        new RegExp(`^http://${a.host.replace(/\./g, '\\.')}/auth/google/return#h=`),
      );
    });

    it('GID4-HOST-02 — started on academy A, completed on academy B (right binder) or on the platform: refused, no session, handoff spent', async () => {
      const a = await academy('p4-xa');
      const b = await academy('p4-xb');
      const person = await register('p4-x', a.host, a.id);
      const sub = newSub();
      await linkGoogle(person.userId, sub, person.email);
      const before = await sessionRows(person.userId);
      const flow = await throughGoogle(a.host, { sub, email: person.email });
      const onB = await complete(b.host, flow.handoff, flow.binder).expect(401);
      expect(onB.body.error.messageKey).toBe('errors.auth.googleSignInExpired');
      // Fail closed: the handoff presented on the wrong origin is spent.
      await complete(a.host, flow.handoff, flow.binder).expect(401);
      const flow2 = await throughGoogle(a.host, { sub, email: person.email });
      await complete(BASE, flow2.handoff, flow2.binder).expect(401);
      expect(await sessionRows(person.userId)).toBe(before);
    });

    it('GID4-HOST-03 — a foreign Origin header cannot start a flow on an academy host', async () => {
      const a = await academy('p4-org');
      const res = await http()
        .post('/auth/google/authorize')
        .set('Host', a.host)
        .set('Origin', 'https://evil.example')
        .send({ intent: 'sign_in' })
        .expect(403);
      expect(res.body.error.messageKey).toBe('errors.auth.googleOriginRefused');
    });
  });

  // ==================================================================
  // Expiry and single use
  // ==================================================================

  describe('GID4-LIFE — expiry and single use', () => {
    it('GID4-LIFE-01 — an expired state is a dead end; an expired handoff and an expired pending step are refused', async () => {
      // Expired state.
      const s1 = await authorize(BASE);
      const g1 = google.approve(s1.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('p4-exp1'),
      });
      await admin.authOAuthFlow.update({
        where: { stateHash: hashFlowSecret(stateOf(s1.authorizationUrl)) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await callback({ code: g1.code, state: g1.state }).expect(400);

      // Expired handoff.
      const f2 = await throughGoogle(BASE, {
        sub: newSub(),
        email: uniqueTestEmail('p4-exp2'),
      });
      await admin.authOAuthFlow.update({
        where: { stateHash: hashFlowSecret(f2.state) },
        data: { handoffExpiresAt: new Date(Date.now() - 1000) },
      });
      await complete(BASE, f2.handoff, f2.binder).expect(401);

      // Expired pending (create step).
      const f3 = await throughGoogle(BASE, {
        sub: newSub(),
        email: uniqueTestEmail('p4-exp3'),
      });
      const step = await complete(BASE, f3.handoff, f3.binder).expect(200);
      expect(step.body.googleStep).toBe('create_account');
      await admin.authOAuthFlow.update({
        where: { stateHash: hashFlowSecret(f3.state) },
        data: { handoffExpiresAt: new Date(Date.now() - 1000) },
      });
      await http()
        .post('/auth/google/create-account')
        .set('Host', BASE)
        .set('Cookie', f3.binder)
        .send({ pending: step.body.pending, name: 'Late Person' })
        .expect(401);
      expect(
        await admin.user.count({ where: { email: { startsWith: 'p4-exp3' } } }),
      ).toBe(0);
    });

    it('GID4-LIFE-02 — a pending step is single-use: after a successful link it cannot be replayed on any step endpoint', async () => {
      const staff = await register('p4-once');
      const flow = await throughGoogle(BASE, { sub: newSub(), email: staff.email });
      const step = await complete(BASE, flow.handoff, flow.binder).expect(200);
      expect(step.body.googleStep).toBe('link_required');
      const linked = await http()
        .post('/auth/google/link')
        .set('Host', BASE)
        .set('Cookie', flow.binder)
        .send({ pending: step.body.pending, password: PASSWORD })
        .expect(200);
      expect(linked.body.emailOtpRequired ?? linked.body.accessToken).toBeTruthy();
      for (const [path, body] of [
        ['/auth/google/link', { pending: step.body.pending, password: PASSWORD }],
        ['/auth/google/create-account', { pending: step.body.pending, name: 'Replay' }],
        ['/auth/google/activate', { pending: step.body.pending }],
        ['/auth/google/complete', { handoff: step.body.pending }],
      ] as const) {
        const res = await http()
          .post(path)
          .set('Host', BASE)
          .set('Cookie', flow.binder)
          .send(body);
        expect(res.status).toBe(401);
        expect(res.body.error.messageKey).toBe('errors.auth.googleSignInExpired');
      }
      expect(
        await admin.userAuthIdentity.count({ where: { userId: staff.userId } }),
      ).toBe(1);
    });
  });

  describe('GID4-RET — flow rows are not kept', () => {
    it('GID4-RET-01 — starting a flow deletes flows whose lifetime ended over 24 h ago, and nothing younger', async () => {
      const make = (label: string, ageMs: number) =>
        admin.authOAuthFlow.create({
          data: {
            provider: 'google',
            stateHash: hashFlowSecret(`${label}-${Date.now()}-${Math.random()}`),
            nonceHash: 'n',
            binderHash: 'b',
            codeVerifier: 'v',
            intent: 'sign_in',
            surface: 'management',
            originHost: `http://${BASE}`,
            providerEmail: uniqueTestEmail(label),
            providerSubject: newSub(),
            createdAt: new Date(Date.now() - ageMs),
            expiresAt: new Date(Date.now() - ageMs + 10 * 60 * 1000),
          },
        });
      const old = await make('p4-ret-old', 3 * 24 * 3600_000);
      const recent = await make('p4-ret-recent', 2 * 3600_000);
      await authorize(BASE);
      expect(await admin.authOAuthFlow.findUnique({ where: { id: old.id } })).toBeNull();
      expect(
        await admin.authOAuthFlow.findUnique({ where: { id: recent.id } }),
      ).not.toBeNull();
    });
  });

  // ==================================================================
  // Linking races
  // ==================================================================

  describe('GID4-RACE — one Google account, one Atlas account', () => {
    async function settingsLinkFlow(
      email: string,
      userId: string,
      sub: string,
      googleEmail: string,
    ) {
      const token = await passwordSession(email, userId);
      return throughGoogle(
        BASE,
        { sub, email: googleEmail },
        { intent: 'link', currentPassword: PASSWORD },
        token,
      );
    }

    it('GID4-RACE-01 — two accounts connect the SAME Google account concurrently: exactly one wins, the other 409', async () => {
      const x = await register('p4-racex');
      const y = await register('p4-racey');
      const sub = newSub();
      const googleEmail = uniqueTestEmail('p4-race-google');
      const fx = await settingsLinkFlow(x.email, x.userId, sub, googleEmail);
      const fy = await settingsLinkFlow(y.email, y.userId, sub, googleEmail);
      const results = await Promise.all([
        complete(BASE, fx.handoff, fx.binder),
        complete(BASE, fy.handoff, fy.binder),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.messageKey).toBe(
        'errors.auth.googleIdentityInUse',
      );
      expect(
        await admin.userAuthIdentity.count({ where: { providerSubject: sub } }),
      ).toBe(1);
    });

    it('GID4-RACE-02 — one account connects two DIFFERENT Google accounts concurrently: exactly one is kept', async () => {
      const x = await register('p4-race2');
      const f1 = await settingsLinkFlow(
        x.email,
        x.userId,
        newSub(),
        uniqueTestEmail('p4-r2a'),
      );
      const f2 = await settingsLinkFlow(
        x.email,
        x.userId,
        newSub(),
        uniqueTestEmail('p4-r2b'),
      );
      const results = await Promise.all([
        complete(BASE, f1.handoff, f1.binder),
        complete(BASE, f2.handoff, f2.binder),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await admin.userAuthIdentity.count({ where: { userId: x.userId } })).toBe(1);
    });

    it('GID4-RACE-03 — settings link without the current password, or with a wrong one, never starts a flow', async () => {
      const x = await register('p4-reauth');
      const token = await passwordSession(x.email, x.userId);
      for (const currentPassword of [undefined, 'wrong-password-xyz']) {
        const res = await http()
          .post('/auth/google/authorize')
          .set('Host', BASE)
          .set('Authorization', `Bearer ${token}`)
          .send({ intent: 'link', ...(currentPassword ? { currentPassword } : {}) })
          .expect(401);
        expect(res.body.error.messageKey).toBe('errors.auth.invalidCurrentPassword');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      // And no session at all: link is refused outright.
      await http()
        .post('/auth/google/authorize')
        .set('Host', BASE)
        .send({ intent: 'link', currentPassword: PASSWORD })
        .expect(401);
    });
  });

  // ==================================================================
  // Enumeration and privacy
  // ==================================================================

  describe('GID4-PRIV — what a Google flow reveals', () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    it('GID4-PRIV-01 — steps carry only the proven address (and Google’s own name); never an id, a status, a role or a membership', async () => {
      const a = await academy('p4-priv');
      const existing = await register('p4-priv-existing', a.host, a.id);
      await seedAcademyMember(admin, a.id, existing.userId, 'instructor');
      const link = await throughGoogle(a.host, { sub: newSub(), email: existing.email });
      const linkStep = await complete(a.host, link.handoff, link.binder).expect(200);
      expect(Object.keys(linkStep.body).sort()).toEqual([
        'email',
        'expiresAt',
        'googleStep',
        'pending',
      ]);

      const fresh = await throughGoogle(a.host, {
        sub: newSub(),
        email: uniqueTestEmail('p4-priv-new'),
        name: 'N',
      });
      const createStep = await complete(a.host, fresh.handoff, fresh.binder).expect(200);
      expect(Object.keys(createStep.body).sort()).toEqual([
        'email',
        'expiresAt',
        'googleStep',
        'name',
        'pending',
      ]);
      for (const body of [linkStep.body, createStep.body]) {
        expect(JSON.stringify({ ...body, pending: '', expiresAt: '' })).not.toMatch(UUID);
      }
    });

    it('GID4-PRIV-02 — every stale/foreign flow answers identically, whether or not an account stands behind it', async () => {
      const staff = await register('p4-same');
      const sub = newSub();
      await linkGoogle(staff.userId, sub, staff.email);
      const real = await throughGoogle(BASE, { sub, email: staff.email });
      const nobody = await throughGoogle(BASE, {
        sub: newSub(),
        email: uniqueTestEmail('p4-nobody'),
      });
      // Right handoff, no binder — linked account vs unknown person.
      const r1 = await complete(BASE, real.handoff).expect(401);
      const r2 = await complete(BASE, nobody.handoff).expect(401);
      const shape = (r: request.Response) => ({
        status: r.status,
        key: r.body.error.messageKey,
        kind: r.body.error.kind,
      });
      expect(shape(r1)).toEqual(shape(r2));
      const r3 = await complete(BASE, 'not-a-handoff', real.binder).expect(401);
      expect(shape(r3)).toEqual(shape(r1));
      for (const r of [r1, r2, r3]) {
        expect(Object.keys(r.body.error).sort()).toEqual([
          'kind',
          'messageKey',
          'requestId',
          'retryable',
          'status',
        ]);
      }
    });

    it('GID4-PRIV-03 — the link step answers a wrong password on a suspended account exactly like any wrong password', async () => {
      const active = await register('p4-wp-active');
      const suspended = await register('p4-wp-susp');
      await admin.user.update({
        where: { id: suspended.userId },
        data: { status: 'suspended' },
      });
      const answers = [];
      for (const who of [active, suspended]) {
        const flow = await throughGoogle(BASE, { sub: newSub(), email: who.email });
        const step = await complete(BASE, flow.handoff, flow.binder).expect(200);
        const res = await http()
          .post('/auth/google/link')
          .set('Host', BASE)
          .set('Cookie', flow.binder)
          .send({ pending: step.body.pending, password: 'definitely-wrong' })
          .expect(401);
        answers.push(res.body.error.messageKey);
      }
      expect(answers).toEqual([
        'errors.auth.invalidCredentials',
        'errors.auth.invalidCredentials',
      ]);
    });
  });

  // ==================================================================
  // A Google-created account can establish a password later
  // ==================================================================

  describe('GID4-PWD — a Google-only account', () => {
    it('GID4-PWD-01 — sets a password through the reset link, signs in with it, and may then disconnect Google', async () => {
      const a = await academy('p4-pwd');
      const email = uniqueTestEmail('p4-pwd');
      const sub = newSub();
      const flow = await throughGoogle(a.host, { sub, email }, { intent: 'sign_up' });
      const step = await complete(a.host, flow.handoff, flow.binder).expect(200);
      await http()
        .post('/auth/google/create-account')
        .set('Host', a.host)
        .set('Cookie', flow.binder)
        .send({ pending: step.body.pending, name: 'Google Only' })
        .expect(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(user.passwordHash.startsWith('nopassword:')).toBe(true);
      // A password sign-in with anything is refused.
      await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({ email, password: 'nopassword:', surface: 'academy', academyId: a.id })
        .expect(401);

      const raw = `p4-reset-${user.id}`;
      await admin.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: PASSWORD })
        .expect((r) => expect(r.status).toBeLessThan(300));

      const signIn = await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id })
        .expect(200);
      const session = signIn.body.accessToken
        ? signIn.body
        : (
            await finishCode(a.host, user.id, signIn.body.challengeId, {
              surface: 'academy',
              academyId: a.id,
            })
          ).body;
      expect(session.authMethod).toBe('password');

      const methods = await http()
        .get('/users/me/sign-in-methods')
        .set('Host', a.host)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(200);
      expect(methods.body.password).toBe(true);
      await http()
        .delete('/users/me/sign-in-methods/google')
        .set('Host', a.host)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: PASSWORD })
        .expect(204);
      // Google again now asks the owner to prove the account — no silent re-link.
      const back = await throughGoogle(a.host, { sub, email });
      expect(
        (await complete(a.host, back.handoff, back.binder).expect(200)).body.googleStep,
      ).toBe('link_required');
    });
  });

  // ==================================================================
  // Observability hygiene
  // ==================================================================

  describe('GID4-OBS — logs and metrics', () => {
    it('GID4-OBS-01 — a failed callback logs what failed, never the code, a token, the client secret, the handoff or the address', async () => {
      const lines: string[] = [];
      const capture = (...args: unknown[]) => {
        lines.push(
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        );
      };
      const spies = [
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      ];
      const email = uniqueTestEmail('p4-logs');
      try {
        const bad = await authorize(BASE);
        const forged = google.approve(bad.authorizationUrl, {
          sub: newSub(),
          email,
          overrides: { forgeSignature: true },
        });
        const failed = await callback({ code: forged.code, state: forged.state }).expect(
          303,
        );
        expect(fragmentOf(failed.headers.location).get('error')).toBe('failed');
        const good = await throughGoogle(BASE, { sub: newSub(), email });
        await complete(BASE, good.handoff, good.binder).expect(200);

        const text = lines.join('\n');
        expect(text).toContain('Google sign-in callback failed.');
        for (const secret of [
          forged.code,
          good.code,
          CLIENT_SECRET,
          good.handoff,
          email,
          forged.state,
        ]) {
          expect(text).not.toContain(secret);
        }
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWT
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('GID4-OBS-02 — atlas_google_auth_total uses only stage/result labels from closed vocabularies', async () => {
      const metrics = await METRICS_REGISTRY.getMetricsAsJSON();
      const google = metrics.find((m) => m.name === 'atlas_google_auth_total');
      expect(google).toBeDefined();
      const values = (
        google as unknown as { values: { labels: Record<string, string> }[] }
      ).values;
      expect(values.length).toBeGreaterThan(0);
      for (const { labels } of values) {
        expect(Object.keys(labels).sort()).toEqual(['result', 'stage']);
        expect(STAGES).toContain(labels.stage);
        expect(RESULTS).toContain(labels.result);
      }
    });
  });
});
