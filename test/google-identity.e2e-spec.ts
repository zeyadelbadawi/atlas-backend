/**
 * Google Identity — Phase 1 (docs/GOOGLE_IDENTITY.md): the flow itself.
 *
 * Runs the REAL backend flow (`/auth/google/authorize` → Google →
 * `/auth/google/callback` → `/auth/google/complete`) against a local fake
 * of Google's token endpoint and JWKS (`utils/fake-google-oidc.ts`). The
 * backend's own OIDC client does the code exchange and every ID-token
 * check; the fake only plays "the person signed in at Google".
 *
 * Phase 1 covers: the state/nonce/PKCE/binder/handoff mechanics, host and
 * origin binding, ID-token verification, the existing-identity sign-in
 * through the unchanged pipeline (A6 code, surface rules, suspension), the
 * follow-up step classification (nothing is ever created or linked by an
 * email match), and the `auth_method` of sessions.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { Counter } from 'prom-client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { FakeGoogleOidc } from './utils/fake-google-oidc';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';

jest.setTimeout(180000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-gid';
const CLIENT_ID = 'atlas-test-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'atlas-test-client-secret';
/** The management/platform host in these tests (local ⇒ unresolvable ⇒ platform). */
const PLATFORM = 'localhost';
const REDIRECT_URI = `http://${PLATFORM}/auth/google/callback`;

const ENV_KEYS = [
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

async function bootApp(env: Record<string, string>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const testApp = await createTestApp({
    overrides: (builder) =>
      builder
        .overrideProvider(CommunicationsProcessor)
        .useClass(InertCommunicationsProcessor)
        .overrideProvider(CommunicationsScheduler)
        .useClass(InertCommunicationsScheduler),
  });
  // Config is read at boot; restore the process environment for other suites.
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return testApp;
}

describe('Google Identity — Phase 1 flow (e2e)', () => {
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
    const testApp = await bootApp({
      FLAG_AUTH_GOOGLE_MODE: 'on',
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
      GOOGLE_OIDC_ISSUER: 'http://fake-google.test',
      GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: 'http://fake-google.test/auth',
      GOOGLE_OIDC_TOKEN_ENDPOINT: `${google.baseUrl}/token`,
      GOOGLE_OIDC_JWKS_URI: `${google.baseUrl}/jwks`,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'new_device',
      FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT: 'off',
    });
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

  interface Academy {
    readonly id: string;
    readonly host: string;
  }

  async function staffAccount(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', PLATFORM)
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function academy(label: string): Promise<Academy> {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: a.id },
      data: { status: 'active', registrationPolicy: 'open' },
    });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gid.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    return { id: a.id, host };
  }

  async function learnerAt(a: Academy, label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', a.host)
      .send({ name: label, email, password: PASSWORD, academyId: a.id })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function linkGoogle(userId: string, sub: string, email: string) {
    await admin.userAuthIdentity.create({
      data: { userId, provider: 'google', providerSubject: sub, emailAtLink: email },
    });
  }

  const newSub = () => `g-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function binderFrom(response: request.Response): string {
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const cookie = cookies.find((c) => c.startsWith('atlas_google_binder='));
    if (!cookie) throw new Error('no binder cookie');
    return cookie.split(';')[0];
  }

  interface Started {
    readonly authorizationUrl: string;
    readonly binder: string;
    readonly setCookie: string;
  }

  async function authorize(
    host: string,
    body: Record<string, unknown> = { intent: 'sign_in' },
  ): Promise<Started> {
    const res = await http()
      .post('/auth/google/authorize')
      .set('Host', host)
      .send(body)
      .expect(200);
    const setCookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('atlas_google_binder='))!;
    return {
      authorizationUrl: res.body.authorizationUrl,
      binder: binderFrom(res),
      setCookie,
    };
  }

  function callback(query: Record<string, string>, host = PLATFORM) {
    return http().get('/auth/google/callback').set('Host', host).query(query);
  }

  function fragmentOf(location: string): URLSearchParams {
    return new URLSearchParams(location.split('#')[1] ?? '');
  }

  /** authorize → "signed in at Google" → callback → the handoff for complete. */
  async function throughGoogle(
    host: string,
    signIn: Parameters<FakeGoogleOidc['approve']>[1],
    body?: Record<string, unknown>,
  ) {
    const started = await authorize(host, body);
    const { code, state } = google.approve(started.authorizationUrl, signIn);
    const res = await callback({ code, state }).expect(303);
    return {
      ...started,
      location: res.headers.location as string,
      handoff: fragmentOf(res.headers.location).get('h') ?? '',
    };
  }

  function complete(host: string, handoff: string, binder?: string) {
    const req = http().post('/auth/google/complete').set('Host', host).send({ handoff });
    return binder ? req.set('Cookie', binder) : req;
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

  async function counterValue(name: string, labels: Record<string, string>) {
    const metric = METRICS_REGISTRY.getSingleMetric(name) as Counter | undefined;
    if (!metric) return 0;
    const data = await metric.get();
    return (
      data.values.find((v) =>
        Object.entries(labels).every(([k, value]) => v.labels[k] === value),
      )?.value ?? 0
    );
  }

  async function latestSessionMethod(userId: string) {
    const row = await admin.refreshToken.findFirstOrThrow({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return row;
  }

  // ==================================================================
  // Authorize
  // ==================================================================

  describe('GID-AUTH — starting a Google sign-in', () => {
    it('GID-AUTH-01 — hands out Google’s URL with PKCE S256, state, nonce and account choice, and a host-only binder cookie', async () => {
      const started = await authorize(PLATFORM);
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe('http://fake-google.test/auth');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('prompt')).toBe('select_account');

      expect(started.setCookie).toMatch(/HttpOnly/i);
      expect(started.setCookie).toMatch(/SameSite=Lax/i);
      expect(started.setCookie).toMatch(/Path=\/auth\/google/);
      expect(started.setCookie).not.toMatch(/Domain=/i);

      // Only hashes are stored; the flow is for the platform (management).
      const flow = await admin.authOAuthFlow.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });
      expect(flow.stateHash).not.toBe(url.searchParams.get('state'));
      expect(flow.stateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(flow.surface).toBe('management');
      expect(flow.academyId).toBeNull();
      expect(flow.originHost).toBe(`http://${PLATFORM}`);
    });

    it('GID-AUTH-02 — an academy host binds the flow to THAT academy; a different body academyId is refused', async () => {
      const a = await academy('auth-host');
      const b = await academy('auth-host-b');
      await authorize(a.host);
      const flow = await admin.authOAuthFlow.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });
      expect(flow.surface).toBe('academy');
      expect(flow.academyId).toBe(a.id);
      expect(flow.originHost).toBe(`http://${a.host}`);

      const mismatch = await http()
        .post('/auth/google/authorize')
        .set('Host', a.host)
        .send({ intent: 'sign_in', academyId: b.id })
        .expect(403);
      expect(mismatch.body.error.messageKey).toBe('errors.auth.academyHostMismatch');
    });

    it('GID-AUTH-03 — an unknown host, a foreign Origin and a bad intent are refused', async () => {
      const unknown = await http()
        .post('/auth/google/authorize')
        .set('Host', 'nobody-owns-this.gid.test')
        .send({ intent: 'sign_in' })
        .expect(400);
      expect(unknown.body.error.messageKey).toBe('errors.auth.academyContextRequired');

      const foreign = await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .set('Origin', 'https://evil.example')
        .send({ intent: 'sign_in' })
        .expect(403);
      expect(foreign.body.error.messageKey).toBe('errors.auth.googleOriginRefused');

      await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .send({ intent: 'link' })
        .expect(400);
    });

    it('GID-AUTH-04 — a return path is kept only when it is relative', async () => {
      for (const [returnTo, kept] of [
        ['/my/courses?tab=1', '/my/courses?tab=1'],
        ['https://evil.example/', null],
        ['//evil.example/x', null],
        ['/\\evil.example', null],
      ] as const) {
        await authorize(PLATFORM, { intent: 'sign_in', returnTo });
        const flow = await admin.authOAuthFlow.findFirstOrThrow({
          orderBy: { createdAt: 'desc' },
        });
        expect(flow.returnPath).toBe(kept);
      }
    });

    it('GID-AUTH-05 — GET /auth/options says Google is offered here, and nothing else', async () => {
      const a = await academy('opts');
      const res = await http().get('/auth/options').set('Host', a.host).expect(200);
      expect(res.body).toEqual({ google: true });
      const mgmt = await http().get('/auth/options').set('Host', PLATFORM).expect(200);
      expect(mgmt.body).toEqual({ google: true });
    });
  });

  // ==================================================================
  // Callback
  // ==================================================================

  describe('GID-CB — Google’s redirect back', () => {
    it('GID-CB-01 — sends the browser back to the ORIGIN it started on, handoff in the fragment only', async () => {
      const a = await academy('cb-origin');
      const started = await authorize(a.host);
      const { code, state } = google.approve(started.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('cb-origin'),
      });
      const res = await callback({ code, state }).expect(303);
      const location = res.headers.location as string;
      expect(location.startsWith(`http://${a.host}/auth/google/return#`)).toBe(true);
      expect(location.split('#')[0]).not.toContain('h=');
      expect(fragmentOf(location).get('h')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('GID-CB-02 — a replayed, unknown or missing state is a dead end (no redirect anywhere)', async () => {
      const started = await authorize(PLATFORM);
      const { code, state } = google.approve(started.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('cb-replay'),
      });
      await callback({ code, state }).expect(303);
      const replay = await callback({ code, state }).expect(400);
      expect(replay.headers.location).toBeUndefined();
      await callback({ code: 'x', state: 'not-a-state' }).expect(400);
      await callback({ code: 'x' }).expect(400);
    });

    it('GID-CB-03 — only the platform host serves the callback', async () => {
      const a = await academy('cb-host');
      const started = await authorize(PLATFORM);
      const { code, state } = google.approve(started.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('cb-host'),
      });
      await callback({ code, state }, a.host).expect(404);
      // The state was not spent by the refused host.
      await callback({ code, state }).expect(303);
    });

    it('GID-CB-04 — cancelling at Google returns #error=cancelled; a provider error returns #error=failed', async () => {
      const before = await counterValue('atlas_google_auth_total', {
        stage: 'callback',
        result: 'cancelled',
      });
      const one = await authorize(PLATFORM);
      const state1 = new URL(one.authorizationUrl).searchParams.get('state')!;
      const cancelled = await callback({ error: 'access_denied', state: state1 }).expect(
        303,
      );
      expect(fragmentOf(cancelled.headers.location).get('error')).toBe('cancelled');
      expect(
        await counterValue('atlas_google_auth_total', {
          stage: 'callback',
          result: 'cancelled',
        }),
      ).toBe(before + 1);

      const two = await authorize(PLATFORM);
      const state2 = new URL(two.authorizationUrl).searchParams.get('state')!;
      const failed = await callback({ error: 'server_error', state: state2 }).expect(303);
      expect(fragmentOf(failed.headers.location).get('error')).toBe('failed');
    });

    it('GID-CB-05 — every ID-token defect is refused (signature, issuer, audience, azp, expiry, nonce) and nothing is handed off', async () => {
      const defects = [
        { forgeSignature: true },
        { iss: 'https://accounts.evil.example' },
        { aud: 'someone-elses-client' },
        { aud: [CLIENT_ID, 'other'], azp: 'other' },
        { exp: Math.floor(Date.now() / 1000) - 3600 },
        { iat: Math.floor(Date.now() / 1000) + 3600 },
        { nonce: 'a-different-nonce' },
        { kid: 'unknown-kid' },
      ];
      for (const overrides of defects) {
        const started = await authorize(PLATFORM);
        const { code, state } = google.approve(started.authorizationUrl, {
          sub: newSub(),
          email: uniqueTestEmail('cb-defect'),
          overrides,
        });
        const res = await callback({ code, state }).expect(303);
        const fragment = fragmentOf(res.headers.location);
        expect({ overrides, error: fragment.get('error'), h: fragment.get('h') }).toEqual(
          {
            overrides,
            error: 'failed',
            h: null,
          },
        );
      }
    });

    it('GID-CB-06 — the code is exchanged with the PKCE verifier of THIS flow (a code bound to another flow fails)', async () => {
      const one = await authorize(PLATFORM);
      const two = await authorize(PLATFORM);
      // Google bound the code to flow ONE's challenge; flow TWO presents it.
      const { code } = google.approve(one.authorizationUrl, {
        sub: newSub(),
        email: uniqueTestEmail('cb-pkce'),
      });
      const state2 = new URL(two.authorizationUrl).searchParams.get('state')!;
      const res = await callback({ code, state: state2 }).expect(303);
      expect(fragmentOf(res.headers.location).get('error')).toBe('failed');
    });
  });

  // ==================================================================
  // Complete
  // ==================================================================

  describe('GID-DONE — completing on the origin', () => {
    it('GID-DONE-01 — the handoff is refused without the starting browser’s binder, on another origin, and when replayed', async () => {
      const email = uniqueTestEmail('done-bind');
      const flow = await throughGoogle(PLATFORM, { sub: newSub(), email });

      const noBinder = await complete(PLATFORM, flow.handoff).expect(401);
      expect(noBinder.body.error.messageKey).toBe('errors.auth.googleSignInExpired');

      // The first attempt spent the handoff; a fresh flow for the rest.
      const again = await throughGoogle(PLATFORM, { sub: newSub(), email });
      const a = await academy('done-bind');
      await complete(a.host, again.handoff, again.binder).expect(401);

      const third = await throughGoogle(PLATFORM, { sub: newSub(), email });
      const wrongBinder = await complete(
        PLATFORM,
        third.handoff,
        'atlas_google_binder=forged',
      ).expect(401);
      expect(wrongBinder.body.error.messageKey).toBe('errors.auth.googleSignInExpired');

      const fourth = await throughGoogle(PLATFORM, { sub: newSub(), email });
      await complete(PLATFORM, fourth.handoff, fourth.binder).expect(200);
      await complete(PLATFORM, fourth.handoff, fourth.binder).expect(401);
    });

    it('GID-DONE-02 — an address Google does not vouch for is refused, whatever exists behind it', async () => {
      const existing = await staffAccount('done-unverified');
      for (const email of [existing.email, uniqueTestEmail('done-unverified-new')]) {
        const flow = await throughGoogle(PLATFORM, {
          sub: newSub(),
          email,
          emailVerified: false,
        });
        const res = await complete(PLATFORM, flow.handoff, flow.binder).expect(403);
        expect(res.body).toMatchObject({
          error: { messageKey: 'errors.auth.googleEmailUnverified' },
        });
      }
      expect(
        await admin.userAuthIdentity.count({ where: { userId: existing.userId } }),
      ).toBe(0);
    });

    it('GID-DONE-03 — no account: a create step with the Google name, and NOTHING created', async () => {
      const email = uniqueTestEmail('done-new');
      const flow = await throughGoogle(PLATFORM, {
        sub: newSub(),
        email,
        name: 'Nour Google',
      });
      const res = await complete(PLATFORM, flow.handoff, flow.binder).expect(200);
      expect(res.body).toEqual({
        googleStep: 'create_account',
        pending: expect.stringMatching(/^p\.[A-Za-z0-9_-]{43}$/),
        expiresAt: expect.any(String),
        email,
        name: 'Nour Google',
      });
      expect(res.body.accessToken).toBeUndefined();
      expect(await admin.user.count({ where: { email } })).toBe(0);
      // The step's secret is not a handoff: `complete` refuses it.
      const asHandoff = await complete(PLATFORM, res.body.pending, flow.binder).expect(
        401,
      );
      expect(asHandoff.body.error.messageKey).toBe('errors.auth.googleSignInExpired');
      // The binder survives for the follow-up step.
      const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cleared.some((c) => c.startsWith('atlas_google_binder=;'))).toBe(false);
    });

    it('GID-DONE-04 — an existing password account with that address: link step, never a link, never another account’s data', async () => {
      const a = await academy('done-link');
      const person = await learnerAt(a, 'done-link-person');
      const flow = await throughGoogle(a.host, {
        sub: newSub(),
        email: person.email.toUpperCase(),
      });
      const res = await complete(a.host, flow.handoff, flow.binder).expect(200);
      expect(res.body).toEqual({
        googleStep: 'link_required',
        pending: expect.any(String),
        expiresAt: expect.any(String),
        email: person.email,
      });
      expect(
        await admin.userAuthIdentity.count({ where: { userId: person.userId } }),
      ).toBe(0);
      expect(await admin.user.count({ where: { email: person.email } })).toBe(1);
    });

    it('GID-DONE-05 — an invited account: activation step only when Google is authoritative for the address', async () => {
      const gmailInvited = `gid-invited-${Date.now()}@gmail.com`;
      const workspaceInvited = uniqueTestEmail('done-invited-ws');
      const consumerInvited = uniqueTestEmail('done-invited-consumer');
      for (const email of [gmailInvited, workspaceInvited, consumerInvited]) {
        await admin.user.create({
          data: { email, name: 'Invited', passwordHash: 'x', status: 'invited' },
        });
      }
      const gmail = await throughGoogle(PLATFORM, { sub: newSub(), email: gmailInvited });
      expect(
        (await complete(PLATFORM, gmail.handoff, gmail.binder).expect(200)).body
          .googleStep,
      ).toBe('activate_invited');
      const wsDomain = workspaceInvited.split('@')[1];
      const ws = await throughGoogle(PLATFORM, {
        sub: newSub(),
        email: workspaceInvited,
        hd: wsDomain,
      });
      expect(
        (await complete(PLATFORM, ws.handoff, ws.binder).expect(200)).body.googleStep,
      ).toBe('activate_invited');
      const consumer = await throughGoogle(PLATFORM, {
        sub: newSub(),
        email: consumerInvited,
      });
      expect(
        (await complete(PLATFORM, consumer.handoff, consumer.binder).expect(200)).body
          .googleStep,
      ).toBe('link_required');
      await admin.user.deleteMany({
        where: { email: { in: [gmailInvited, workspaceInvited, consumerInvited] } },
      });
    });

    it('GID-DONE-06 — a linked Google identity signs in on management: session with authMethod google, carried through refresh', async () => {
      const staff = await staffAccount('done-mgmt');
      const sub = newSub();
      await linkGoogle(staff.userId, sub, staff.email);
      // Google reports a different address today: the SUBJECT is the key.
      const flow = await throughGoogle(PLATFORM, {
        sub,
        email: uniqueTestEmail('done-mgmt-renamed'),
      });
      const res = await complete(PLATFORM, flow.handoff, flow.binder).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.authMethod).toBe('google');
      expect(res.body.user.id).toBe(staff.userId);
      const cleared = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cleared.some((c) => c.startsWith('atlas_google_binder=;'))).toBe(true);

      const row = await latestSessionMethod(staff.userId);
      expect(row.authMethod).toBe('google');
      expect(row.surface).toBe('management');

      const refreshed = await http()
        .post('/auth/refresh')
        .set('Host', PLATFORM)
        .send({ refreshToken: res.body.refreshToken })
        .expect(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      expect((await latestSessionMethod(staff.userId)).authMethod).toBe('google');

      const identity = await admin.userAuthIdentity.findFirstOrThrow({
        where: { userId: staff.userId },
      });
      expect(identity.lastUsedAt).not.toBeNull();
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: staff.userId } }))
          .lastSignInAt,
      ).not.toBeNull();
    });

    it('GID-DONE-07 — on an academy website Google replaces ONLY the password: the academy’s emailed code (A6) still applies', async () => {
      const a = await academy('done-a6');
      const person = await learnerAt(a, 'done-a6-person');
      const sub = newSub();
      await linkGoogle(person.userId, sub, person.email);
      const flow = await throughGoogle(a.host, { sub, email: person.email });
      const res = await complete(a.host, flow.handoff, flow.binder).expect(200);
      expect(res.body.emailOtpRequired).toBe(true);
      expect(res.body.accessToken).toBeUndefined();

      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', a.host)
        .send({
          challengeId: res.body.challengeId,
          code: await latestCode(person.userId),
          rememberDevice: false,
          surface: 'academy',
        })
        .expect(200);
      expect(session.body.authMethod).toBe('google');
      const row = await latestSessionMethod(person.userId);
      expect(row).toMatchObject({
        authMethod: 'google',
        surface: 'academy',
        academyId: a.id,
      });
    });

    it('GID-DONE-08 — surface and account rules apply unchanged: learner on management refused, suspended refused', async () => {
      const a = await academy('done-rules');
      const learner = await learnerAt(a, 'done-rules-learner');
      const learnerSub = newSub();
      await linkGoogle(learner.userId, learnerSub, learner.email);
      const mgmt = await throughGoogle(PLATFORM, {
        sub: learnerSub,
        email: learner.email,
      });
      const refused = await complete(PLATFORM, mgmt.handoff, mgmt.binder).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.studentUseAcademySignIn');

      const staff = await staffAccount('done-rules-suspended');
      const suspendedSub = newSub();
      await linkGoogle(staff.userId, suspendedSub, staff.email);
      await admin.user.update({
        where: { id: staff.userId },
        data: { status: 'suspended' },
      });
      const suspended = await throughGoogle(PLATFORM, {
        sub: suspendedSub,
        email: staff.email,
      });
      const res = await complete(PLATFORM, suspended.handoff, suspended.binder).expect(
        403,
      );
      expect(res.body.error.messageKey).toBe('errors.auth.accountSuspended');
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: staff.userId } })).status,
      ).toBe('suspended');
      // No session was minted for the suspended account.
      expect(await admin.refreshToken.count({ where: { userId: staff.userId } })).toBe(0);
    });

    it('GID-DONE-09 — the return path travels back with the result', async () => {
      const staff = await staffAccount('done-return');
      const sub = newSub();
      await linkGoogle(staff.userId, sub, staff.email);
      const flow = await throughGoogle(
        PLATFORM,
        { sub, email: staff.email },
        { intent: 'sign_in', returnTo: '/dashboard/courses' },
      );
      const res = await complete(PLATFORM, flow.handoff, flow.binder).expect(200);
      expect(res.body.returnPath).toBe('/dashboard/courses');
    });
  });

  // ==================================================================
  // Password sessions carry their method too
  // ==================================================================

  it('GID-PW-01 — a password sign-in says authMethod password, on the session and its row', async () => {
    const staff = await staffAccount('pw-method');
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', PLATFORM)
      .send({ email: staff.email, password: PASSWORD })
      .expect(200);
    expect(res.body.authMethod).toBe('password');
    expect((await latestSessionMethod(staff.userId)).authMethod).toBe('password');
  });

  it('GID-DEL-01 — account deletion removes the Google identity (the Google account may start afresh)', async () => {
    const staff = await staffAccount('del-identity');
    await linkGoogle(staff.userId, newSub(), staff.email);
    const signIn = await http()
      .post('/auth/sign-in')
      .set('Host', PLATFORM)
      .send({ email: staff.email, password: PASSWORD })
      .expect(200);
    await http()
      .post('/users/me/delete')
      .set('Host', PLATFORM)
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .send({ confirm: true });
    const user = await admin.user.findUniqueOrThrow({ where: { id: staff.userId } });
    if (user.status === 'deleted') {
      expect(
        await admin.userAuthIdentity.count({ where: { userId: staff.userId } }),
      ).toBe(0);
    } else {
      throw new Error(
        'self-deletion did not complete — check the delete DTO in this test',
      );
    }
  });
});

describe('Google Identity — flag gating (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  afterEach(async () => {
    await admin?.$disconnect();
    await app?.close();
  });

  it('GID-FLAG-01 — off: every Google route answers 404 and the options say no', async () => {
    const testApp = await bootApp({ FLAG_AUTH_GOOGLE_MODE: 'off' });
    app = testApp.app;
    admin = createAdminPrisma();
    const http = () => request(app.getHttpServer());
    await http()
      .post('/auth/google/authorize')
      .set('Host', PLATFORM)
      .send({ intent: 'sign_in' })
      .expect(404);
    await http()
      .get('/auth/google/callback')
      .set('Host', PLATFORM)
      .query({ state: 'x', code: 'y' })
      .expect(400);
    await http()
      .post('/auth/google/complete')
      .set('Host', PLATFORM)
      .send({ handoff: 'x' })
      .expect(404);
    expect(
      (await http().get('/auth/options').set('Host', PLATFORM).expect(200)).body,
    ).toEqual({
      google: false,
    });
  });

  it('GID-FLAG-02 — allowlist: only the listed academies’ websites; management stays off', async () => {
    admin = createAdminPrisma();
    const org = await admin.organization.findFirstOrThrow();
    const listed = await seedAcademy(admin, org.id, `gid-flag-listed-${Date.now()}`);
    const other = await seedAcademy(admin, org.id, `gid-flag-other-${Date.now()}`);
    const hostFor = async (id: string, label: string) => {
      const host = `${label}-${Date.now()}.gid.test`;
      await admin.domainConnection.create({
        data: { academyId: id, hostname: host, status: 'connected' },
      });
      await admin.academy.update({ where: { id }, data: { status: 'active' } });
      return host;
    };
    const listedHost = await hostFor(listed.id, 'listed');
    const otherHost = await hostFor(other.id, 'other');
    const testApp = await bootApp({
      FLAG_AUTH_GOOGLE_MODE: 'allowlist',
      FLAG_AUTH_GOOGLE_ACADEMY_IDS: listed.id,
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      GOOGLE_OAUTH_REDIRECT_URI: REDIRECT_URI,
    });
    app = testApp.app;
    const http = () => request(app.getHttpServer());
    expect(
      (await http().get('/auth/options').set('Host', listedHost).expect(200)).body,
    ).toEqual({ google: true });
    expect(
      (await http().get('/auth/options').set('Host', otherHost).expect(200)).body,
    ).toEqual({ google: false });
    expect(
      (await http().get('/auth/options').set('Host', PLATFORM).expect(200)).body,
    ).toEqual({ google: false });
    await http()
      .post('/auth/google/authorize')
      .set('Host', listedHost)
      .send({ intent: 'sign_in' })
      .expect(200);
    await http()
      .post('/auth/google/authorize')
      .set('Host', otherHost)
      .send({ intent: 'sign_in' })
      .expect(404);
    await http()
      .post('/auth/google/authorize')
      .set('Host', PLATFORM)
      .send({ intent: 'sign_in' })
      .expect(404);
  });
});
