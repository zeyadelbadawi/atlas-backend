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
import { sessionTokenFrom } from './utils/session-cookie';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { Counter } from 'prom-client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { deletionCodeFor } from './utils/account-deletion';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { FakeGoogleOidc } from './utils/fake-google-oidc';
import { existsSync, readFileSync } from 'node:fs';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../src/identity/utils/opaque-token.util';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';
import { uniqueName } from './utils/unique-name';

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
  'FLAG_AUTH_GOOGLE_PLATFORM',
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

  async function academy(
    label: string,
    policy: 'open' | 'approval' | 'invite' = 'open',
  ): Promise<Academy> {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: a.id },
      data: { status: 'active', registrationPolicy: policy },
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
        .send({ intent: 'no_such_intent' })
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
          data: { email, name: 'Invited', status: 'invited' },
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
        .send({ refreshToken: sessionTokenFrom(res) })
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
      .send({
        ...(await deletionCodeFor(app, admin, signIn.body.accessToken)),
        confirm: true,
      });
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

  // ==================================================================
  // Phase 2 — binding the identity
  // ==================================================================

  function step(
    path: string,
    host: string,
    binder: string,
    body: Record<string, unknown>,
  ) {
    return http()
      .post(`/auth/google/${path}`)
      .set('Host', host)
      .set('Cookie', binder)
      .send(body);
  }

  /** Google → complete → the follow-up step (with its binder). */
  async function toStep(
    host: string,
    signIn: Parameters<FakeGoogleOidc['approve']>[1],
    body?: Record<string, unknown>,
  ) {
    const flow = await throughGoogle(host, signIn, body);
    const res = await complete(host, flow.handoff, flow.binder).expect(200);
    return {
      binder: flow.binder,
      step: res.body as { googleStep: string; pending: string },
    };
  }

  async function passwordToken(email: string, host = PLATFORM): Promise<string> {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function verifyOtp(host: string, userId: string, challengeId: string) {
    return http()
      .post('/auth/otp/verify')
      .set('Host', host)
      .send({
        challengeId,
        code: await latestCode(userId),
        rememberDevice: false,
        surface: 'academy',
      })
      .expect(200);
  }

  async function outbox(userId: string, key: string): Promise<number> {
    return admin.communicationOutbox.count({ where: { recipientUserId: userId, key } });
  }

  describe('GID-LINK — an existing password account connects Google (link_required)', () => {
    it('GID-LINK-01 — wrong password: generic 401 and the step stays open; right password links, then the academy code (A6) applies', async () => {
      const a = await academy('link-a6');
      const person = await learnerAt(a, 'link-a6-person');
      const sub = newSub();
      const { binder, step: s } = await toStep(a.host, { sub, email: person.email });
      expect(s.googleStep).toBe('link_required');

      const wrong = await step('link', a.host, binder, {
        pending: s.pending,
        password: 'nope-nope-nope',
      }).expect(401);
      expect(wrong.body.error.messageKey).toBe('errors.auth.invalidCredentials');
      expect(
        await admin.userAuthIdentity.count({ where: { userId: person.userId } }),
      ).toBe(0);

      const ok = await step('link', a.host, binder, {
        pending: s.pending,
        password: PASSWORD,
      }).expect(200);
      expect(ok.body.emailOtpRequired).toBe(true);
      const session = await verifyOtp(a.host, person.userId, ok.body.challengeId);
      expect(session.body.authMethod).toBe('google');

      const identity = await admin.userAuthIdentity.findFirstOrThrow({
        where: { userId: person.userId },
      });
      expect(identity).toMatchObject({
        provider: 'google',
        providerSubject: sub,
        emailAtLink: person.email,
      });
      expect(await outbox(person.userId, 'auth.identity.linked')).toBe(1);
      expect(
        await admin.auditLogEntry.count({
          where: { actorUserId: person.userId, action: 'auth.identity.linked' },
        }),
      ).toBe(1);

      // The step is spent.
      await step('link', a.host, binder, {
        pending: s.pending,
        password: PASSWORD,
      }).expect(401);

      // Next time the same Google account signs straight in (no step).
      const again = await throughGoogle(a.host, { sub, email: person.email });
      const res = await complete(a.host, again.handoff, again.binder).expect(200);
      expect(res.body.googleStep).toBeUndefined();
      expect(res.body.emailOtpRequired ?? res.body.accessToken).toBeTruthy();
      expect(await admin.user.count({ where: { email: person.email } })).toBe(1);
    });

    it('GID-LINK-02 — a Platform Owner connects Google only from settings; a suspended account is refused after its password', async () => {
      const owner = await staffAccount('link-po');
      await admin.user.update({
        where: { id: owner.userId },
        data: { isPlatformOwner: true },
      });
      const po = await toStep(PLATFORM, { sub: newSub(), email: owner.email });
      const refused = await step('link', PLATFORM, po.binder, {
        pending: po.step.pending,
        password: PASSWORD,
      }).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.googleLinkFromSettings');

      const staff = await staffAccount('link-suspended');
      await admin.user.update({
        where: { id: staff.userId },
        data: { status: 'suspended' },
      });
      const sus = await toStep(PLATFORM, { sub: newSub(), email: staff.email });
      const res = await step('link', PLATFORM, sus.binder, {
        pending: sus.step.pending,
        password: PASSWORD,
      }).expect(403);
      expect(res.body.error.messageKey).toBe('errors.auth.accountSuspended');
      expect(
        await admin.userAuthIdentity.count({
          where: { userId: { in: [owner.userId, staff.userId] } },
        }),
      ).toBe(0);
    });

    it('GID-LINK-03 — an account that already has a different Google account is refused (409), nothing changes', async () => {
      const staff = await staffAccount('link-twice');
      await linkGoogle(staff.userId, newSub(), staff.email);
      const other = await toStep(PLATFORM, { sub: newSub(), email: staff.email });
      // The address matches but the subject differs: a link step…
      expect(other.step.googleStep).toBe('link_required');
      const res = await step('link', PLATFORM, other.binder, {
        pending: other.step.pending,
        password: PASSWORD,
      }).expect(409);
      expect(res.body.error.messageKey).toBe('errors.auth.googleAlreadyLinked');
      expect(
        await admin.userAuthIdentity.count({ where: { userId: staff.userId } }),
      ).toBe(1);
    });

    it('GID-LINK-04 — Case 4: an instructor at A signs UP with Google at B: linked once, joins B as a learner, A untouched, one user', async () => {
      const a = await academy('link-c4-a');
      const b = await academy('link-c4-b');
      const staff = await staffAccount('link-c4-instructor');
      await seedAcademyMember(admin, a.id, staff.userId, 'instructor');
      const { binder, step: s } = await toStep(
        b.host,
        { sub: newSub(), email: staff.email },
        { intent: 'sign_up' },
      );
      expect(s.googleStep).toBe('link_required');
      const ok = await step('link', b.host, binder, {
        pending: s.pending,
        password: PASSWORD,
      }).expect(200);
      expect(ok.body.emailOtpRequired).toBe(true);
      expect(await admin.user.count({ where: { email: staff.email } })).toBe(1);
      const rows = await admin.academyStudent.findMany({
        where: { userId: staff.userId },
      });
      expect(rows.map((r) => r.academyId)).toEqual([b.id]);
      expect(
        await admin.academyMember.count({
          where: { userId: staff.userId, academyId: a.id },
        }),
      ).toBe(1);
      expect(await outbox(staff.userId, 'account.academy.joined')).toBe(1);
    });
  });

  describe('GID-NEW — a new person creates an account with Google (create_account)', () => {
    it('GID-NEW-01 — academy signup: one account, verified (Gmail), no password, learner here; the academy code (A6) still applies', async () => {
      const a = await academy('new-a');
      const email = `gid-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@gmail.com`;
      const sub = newSub();
      const { binder, step: s } = await toStep(
        a.host,
        { sub, email, name: 'Nour G' },
        { intent: 'sign_up' },
      );
      expect(s.googleStep).toBe('create_account');
      const res = await step('create-account', a.host, binder, {
        pending: s.pending,
        name: 'Nour G',
      }).expect(201);
      expect(res.body.emailOtpRequired).toBe(true);

      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(await admin.userCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(user.name).toBe('Nour G');
      expect(
        await admin.userAuthIdentity.count({
          where: { userId: user.id, providerSubject: sub },
        }),
      ).toBe(1);
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row).toMatchObject({ academyId: a.id, status: 'active' });

      const session = await verifyOtp(a.host, user.id, res.body.challengeId);
      expect(session.body.authMethod).toBe('google');
      const methods = await http()
        .get('/users/me/sign-in-methods')
        .set('Host', a.host)
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .expect(200);
      expect(methods.body).toEqual({
        password: false,
        google: { email, linkedAt: expect.any(String) },
      });

      // A password never verifies against a Google-only account.
      await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({ email, password: '', surface: 'academy', academyId: a.id })
        .expect((r) => expect([400, 401]).toContain(r.status));
      await admin.userAuthIdentity.deleteMany({ where: { userId: user.id } });
    });

    it('GID-NEW-02 — an address Google is not authoritative for is NOT marked verified', async () => {
      const email = uniqueTestEmail('new-consumer');
      const { binder, step: s } = await toStep(PLATFORM, { sub: newSub(), email });
      await step('create-account', PLATFORM, binder, {
        pending: s.pending,
        name: 'Consumer',
      }).expect(201);
      expect(
        (await admin.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt,
      ).toBeNull();
    });

    it('GID-NEW-03 — organization fields on an academy site are refused and the step stays open for a corrected retry', async () => {
      const a = await academy('new-orgfields');
      const email = uniqueTestEmail('new-orgfields');
      const { binder, step: s } = await toStep(a.host, { sub: newSub(), email });
      const bad = await step('create-account', a.host, binder, {
        pending: s.pending,
        name: 'XX',
        organizationName: uniqueName('Should not be here'),
      }).expect(400);
      expect([
        'errors.auth.signupFieldsNotAllowed',
        'errors.auth.organizationSignupDisabled',
      ]).toContain(bad.body.error.messageKey);
      expect(await admin.user.count({ where: { email } })).toBe(0);
      await step('create-account', a.host, binder, {
        pending: s.pending,
        name: 'XX',
      }).expect(201);
      expect(await admin.user.count({ where: { email } })).toBe(1);
    });

    it('GID-NEW-04 — the registration policy is authoritative: approval → pending; invite without a code → refused, retryable', async () => {
      const approval = await academy('new-approval', 'approval');
      const e1 = uniqueTestEmail('new-approval');
      const s1 = await toStep(
        approval.host,
        { sub: newSub(), email: e1 },
        { intent: 'sign_up' },
      );
      await step('create-account', approval.host, s1.binder, {
        pending: s1.step.pending,
        name: 'AA',
      }).expect(201);
      const u1 = await admin.user.findUniqueOrThrow({ where: { email: e1 } });
      expect(
        (await admin.academyStudent.findFirstOrThrow({ where: { userId: u1.id } }))
          .status,
      ).toBe('pending');

      const invite = await academy('new-invite', 'invite');
      const e2 = uniqueTestEmail('new-invite');
      const s2 = await toStep(
        invite.host,
        { sub: newSub(), email: e2 },
        { intent: 'sign_up' },
      );
      const refused = await step('create-account', invite.host, s2.binder, {
        pending: s2.step.pending,
        name: 'BB',
      }).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.inviteRequired');
      expect(await admin.user.count({ where: { email: e2 } })).toBe(0);
      // Still open: a (bad) code is a 400, not a dead step.
      await step('create-account', invite.host, s2.binder, {
        pending: s2.step.pending,
        name: 'BB',
        inviteToken: 'not-a-real-invite',
      }).expect((r) => expect([400, 403]).toContain(r.status));
    });

    it('GID-NEW-05 — two first sign-ins with the same Google account race: one account, the other 409', async () => {
      const email = uniqueTestEmail('new-race');
      const sub = newSub();
      const one = await toStep(PLATFORM, { sub, email });
      const two = await toStep(PLATFORM, { sub, email });
      const results = await Promise.all([
        step('create-account', PLATFORM, one.binder, {
          pending: one.step.pending,
          name: 'RR',
        }),
        step('create-account', PLATFORM, two.binder, {
          pending: two.step.pending,
          name: 'RR',
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await admin.user.count({ where: { email } })).toBe(1);
      expect(
        await admin.userAuthIdentity.count({ where: { providerSubject: sub } }),
      ).toBe(1);
    });

    it('GID-NEW-06 — Case 3: the Google account from academy A signs UP at B: same user, joins B, A kept; again at A: no duplicate', async () => {
      const a = await academy('new-c3-a');
      const b = await academy('new-c3-b');
      const email = uniqueTestEmail('new-c3');
      const sub = newSub();
      const first = await toStep(a.host, { sub, email }, { intent: 'sign_up' });
      await step('create-account', a.host, first.binder, {
        pending: first.step.pending,
        name: 'Ahmed',
      }).expect(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });

      const atB = await throughGoogle(b.host, { sub, email }, { intent: 'sign_up' });
      const resB = await complete(b.host, atB.handoff, atB.binder).expect(200);
      expect(resB.body.googleStep).toBeUndefined();
      expect(resB.body.emailOtpRequired).toBe(true); // B's own code (A6)
      const rows = await admin.academyStudent.findMany({ where: { userId: user.id } });
      expect(rows.map((r) => r.academyId).sort()).toEqual([a.id, b.id].sort());
      expect(await admin.user.count({ where: { email } })).toBe(1);

      const againA = await throughGoogle(a.host, { sub, email }, { intent: 'sign_up' });
      await complete(a.host, againA.handoff, againA.binder).expect(200);
      expect(await admin.academyStudent.count({ where: { userId: user.id } })).toBe(2);
    });

    it('GID-NEW-07 — an address registered meanwhile turns the create step into a 409 (never a second account)', async () => {
      const email = uniqueTestEmail('new-taken');
      const s = await toStep(PLATFORM, { sub: newSub(), email });
      await http()
        .post('/auth/register')
        .set('Host', PLATFORM)
        .send({ name: 'PP', email, password: PASSWORD })
        .expect(201);
      const res = await step('create-account', PLATFORM, s.binder, {
        pending: s.step.pending,
        name: 'GG',
      }).expect(409);
      expect(res.body.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
      expect(await admin.user.count({ where: { email } })).toBe(1);
    });
  });

  describe('GID-INV — invited accounts', () => {
    it('GID-INV-01 — Google activates an invited Gmail account: active, verified, no password, setup links spent', async () => {
      const email = `gid-inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@gmail.com`;
      const invited = await admin.user.create({
        data: { email, name: 'Invited', status: 'invited' },
      });
      await admin.passwordResetToken.create({
        data: {
          userId: invited.id,
          tokenHash: hashOpaqueToken(`raw-${invited.id}`),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const { binder, step: s } = await toStep(PLATFORM, { sub: newSub(), email });
      expect(s.googleStep).toBe('activate_invited');
      const res = await step('activate', PLATFORM, binder, { pending: s.pending }).expect(
        200,
      );
      expect(res.body.accessToken ?? res.body.emailOtpRequired).toBeTruthy();
      const user = await admin.user.findUniqueOrThrow({ where: { id: invited.id } });
      expect(user.status).toBe('active');
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(await admin.userCredential.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await admin.passwordResetToken.count({
          where: { userId: invited.id, usedAt: null },
        }),
      ).toBe(0);
      expect(await admin.userAuthIdentity.count({ where: { userId: invited.id } })).toBe(
        1,
      );
    });

    it('GID-INV-02 — the setup page: the setup token proves the mailbox, any verified Google account becomes the sign-in', async () => {
      const email = uniqueTestEmail('inv-setup');
      const invited = await admin.user.create({
        data: { email, name: 'Setup', status: 'invited' },
      });
      const raw = `setup-${invited.id}`;
      await admin.passwordResetToken.create({
        data: {
          userId: invited.id,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      const bad = await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .send({ intent: 'setup', setupToken: 'wrong' })
        .expect(401);
      expect(bad.body.error.messageKey).toBe('errors.auth.invalidResetToken');

      const googleEmail = uniqueTestEmail('inv-setup-google');
      const flow = await throughGoogle(
        PLATFORM,
        { sub: newSub(), email: googleEmail },
        { intent: 'setup', setupToken: raw },
      );
      const res = await complete(PLATFORM, flow.handoff, flow.binder).expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.id).toBe(invited.id);
      const user = await admin.user.findUniqueOrThrow({ where: { id: invited.id } });
      expect(user).toMatchObject({ status: 'active', email });
      expect(
        await admin.passwordResetToken.count({
          where: { userId: invited.id, usedAt: null },
        }),
      ).toBe(0);
      expect(
        (await admin.userAuthIdentity.findFirstOrThrow({ where: { userId: invited.id } }))
          .emailAtLink,
      ).toBe(googleEmail);
    });
  });

  describe('GID-SET — Account settings: connect, list, disconnect', () => {
    it('GID-SET-01 — a signed-in account connects a Google account with ANOTHER address; that Google account then signs into it', async () => {
      const staff = await staffAccount('set-link');
      const token = await passwordToken(staff.email);
      const googleEmail = uniqueTestEmail('set-link-personal');
      const sub = newSub();
      const started = await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .set('Authorization', `Bearer ${token}`)
        .send({
          intent: 'link',
          returnTo: '/settings/security',
          currentPassword: PASSWORD,
        })
        .expect(200);
      const binder = binderFrom(started);
      const { code, state } = google.approve(started.body.authorizationUrl, {
        sub,
        email: googleEmail,
      });
      const cb = await callback({ code, state }).expect(303);
      const res = await complete(
        PLATFORM,
        fragmentOf(cb.headers.location).get('h')!,
        binder,
      ).expect(200);
      expect(res.body).toEqual({
        linked: true,
        email: googleEmail,
        returnPath: '/settings/security',
      });
      expect(res.body.accessToken).toBeUndefined();
      expect(await outbox(staff.userId, 'auth.identity.linked')).toBe(1);

      const signIn = await throughGoogle(PLATFORM, { sub, email: googleEmail });
      const session = await complete(PLATFORM, signIn.handoff, signIn.binder).expect(200);
      expect(session.body.user.id).toBe(staff.userId);
    });

    it('GID-SET-02 — linking needs a session; a Google account owned by someone else is refused (409); a Platform Owner may link here', async () => {
      await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .send({ intent: 'link' })
        .expect(401);

      // Re-authentication: a session alone cannot attach a sign-in method.
      const reauth = await staffAccount('set-reauth');
      const reauthToken = await passwordToken(reauth.email);
      for (const currentPassword of [undefined, 'wrong-password-x']) {
        const refused = await http()
          .post('/auth/google/authorize')
          .set('Host', PLATFORM)
          .set('Authorization', `Bearer ${reauthToken}`)
          .send({ intent: 'link', ...(currentPassword ? { currentPassword } : {}) })
          .expect(401);
        expect(refused.body.error.messageKey).toBe('errors.auth.invalidCurrentPassword');
      }

      const owner = await staffAccount('set-owner');
      const ownedSub = newSub();
      await linkGoogle(owner.userId, ownedSub, owner.email);
      const other = await staffAccount('set-other');
      const token = await passwordToken(other.email);
      const started = await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .set('Authorization', `Bearer ${token}`)
        .send({ intent: 'link', currentPassword: PASSWORD })
        .expect(200);
      const { code, state } = google.approve(started.body.authorizationUrl, {
        sub: ownedSub,
        email: owner.email,
      });
      const cb = await callback({ code, state }).expect(303);
      const res = await complete(
        PLATFORM,
        fragmentOf(cb.headers.location).get('h')!,
        binderFrom(started),
      ).expect(409);
      expect(res.body.error.messageKey).toBe('errors.auth.googleIdentityInUse');
      expect(JSON.stringify(res.body)).not.toContain(owner.email);
      expect(
        await admin.userAuthIdentity.count({ where: { userId: other.userId } }),
      ).toBe(0);

      const po = await staffAccount('set-po');
      await admin.user.update({
        where: { id: po.userId },
        data: { isPlatformOwner: true },
      });
      const poToken = await passwordToken(po.email);
      const poStart = await http()
        .post('/auth/google/authorize')
        .set('Host', PLATFORM)
        .set('Authorization', `Bearer ${poToken}`)
        .send({ intent: 'link', currentPassword: PASSWORD })
        .expect(200);
      const poGoogle = google.approve(poStart.body.authorizationUrl, {
        sub: newSub(),
        email: po.email,
      });
      const poCb = await callback(poGoogle).expect(303);
      await complete(
        PLATFORM,
        fragmentOf(poCb.headers.location).get('h')!,
        binderFrom(poStart),
      ).expect(200);
      expect(await admin.userAuthIdentity.count({ where: { userId: po.userId } })).toBe(
        1,
      );
    });

    it('GID-SET-03 — disconnect needs the current password; a Google-only account must set a password first', async () => {
      const staff = await staffAccount('set-unlink');
      await linkGoogle(staff.userId, newSub(), staff.email);
      const token = await passwordToken(staff.email);
      const auth = { Authorization: `Bearer ${token}` };
      const listed = await http()
        .get('/users/me/sign-in-methods')
        .set('Host', PLATFORM)
        .set(auth)
        .expect(200);
      expect(listed.body).toEqual({
        password: true,
        google: { email: staff.email, linkedAt: expect.any(String) },
      });

      const wrong = await http()
        .delete('/users/me/sign-in-methods/google')
        .set('Host', PLATFORM)
        .set(auth)
        .send({ currentPassword: 'wrong-password-x' })
        .expect(401);
      expect(wrong.body.error.messageKey).toBe('errors.auth.invalidCurrentPassword');
      await http()
        .delete('/users/me/sign-in-methods/google')
        .set('Host', PLATFORM)
        .set(auth)
        .send({ currentPassword: PASSWORD })
        .expect(204);
      expect(
        await admin.userAuthIdentity.count({ where: { userId: staff.userId } }),
      ).toBe(0);
      expect(await outbox(staff.userId, 'auth.identity.unlinked')).toBe(1);
      const after = await http()
        .get('/users/me/sign-in-methods')
        .set('Host', PLATFORM)
        .set(auth)
        .expect(200);
      expect(after.body.google).toBeNull();

      // Google-only: refused, it would lock the account out.
      const email = uniqueTestEmail('set-google-only');
      const s = await toStep(PLATFORM, { sub: newSub(), email });
      const created = await step('create-account', PLATFORM, s.binder, {
        pending: s.step.pending,
        name: 'GG',
      }).expect(201);
      const refused = await http()
        .delete('/users/me/sign-in-methods/google')
        .set('Host', PLATFORM)
        .set({ Authorization: `Bearer ${created.body.accessToken}` })
        .send({ currentPassword: 'anything-at-all' })
        .expect(409);
      expect(refused.body.error.messageKey).toBe('errors.auth.setPasswordFirst');
    });
  });

  // ==================================================================
  // Phase 2 hardening — invite-only academy + an existing Google identity
  // ==================================================================

  describe('GID-INVITE — an existing Google-linked account redeems an academy invitation', () => {
    /** A learner invitation for `academyId` (the canonical `academy_invites` row). */
    async function invite(
      academyId: string,
      createdBy: string,
      opts: {
        email?: string | null;
        maxUses?: number;
        usedCount?: number;
        expiresAt?: Date;
        revokedAt?: Date | null;
      } = {},
    ): Promise<{ raw: string; id: string }> {
      const raw = generateOpaqueToken();
      const row = await admin.academyInvite.create({
        data: {
          academyId,
          tokenHash: hashOpaqueToken(raw),
          createdBy,
          email: opts.email === undefined ? null : opts.email,
          maxUses: opts.maxUses ?? 1,
          usedCount: opts.usedCount ?? 0,
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 3600_000),
          revokedAt: opts.revokedAt ?? null,
        },
      });
      return { raw, id: row.id };
    }

    /**
     * Ahmed: learner at A, INSTRUCTOR at A2, Google connected. B is
     * invite-only. Returns everything a test needs to prove nothing else moved.
     */
    async function ahmed(label: string) {
      const a = await academy(`${label}-a`);
      const a2 = await academy(`${label}-a2`);
      const b = await academy(`${label}-b`, 'invite');
      const person = await learnerAt(a, `${label}-ahmed`);
      await seedAcademyMember(admin, a2.id, person.userId, 'instructor');
      const sub = newSub();
      await linkGoogle(person.userId, sub, person.email);
      const owner = (
        await admin.academyMember.findFirstOrThrow({
          where: { academyId: b.id, role: 'owner' },
        })
      ).userId;
      return { a, a2, b, person, sub, owner };
    }

    async function signUpWithGoogle(
      b: Academy,
      sub: string,
      email: string,
      inviteToken?: string,
      expected?: number,
    ) {
      const flow = await throughGoogle(b.host, { sub, email }, { intent: 'sign_up' });
      const req = http()
        .post('/auth/google/complete')
        .set('Host', b.host)
        .set('Cookie', flow.binder)
        .send({ handoff: flow.handoff, ...(inviteToken ? { inviteToken } : {}) });
      return expected ? req.expect(expected) : req;
    }

    async function snapshot(userId: string) {
      const [students, staff, users] = await Promise.all([
        admin.academyStudent.findMany({
          where: { userId },
          select: { academyId: true, status: true, source: true },
          orderBy: { academyId: 'asc' },
        }),
        admin.academyMember.findMany({
          where: { userId },
          select: { academyId: true, role: true, status: true },
          orderBy: { academyId: 'asc' },
        }),
        admin.user.count({ where: { id: userId } }),
      ]);
      return { students, staff, users };
    }

    /** The user-facing copy exists in English AND Arabic (when the frontend is checked out). */
    function expectBilingualCopy(messageKey: string) {
      const root = process.env.ATLAS_FRONTEND_DIR ?? '/home/user/atlas-front';
      const key = messageKey.replace(/^errors\./, '').split('.');
      for (const lang of ['en', 'ar']) {
        const file = `${root}/src/localization/resources/${lang}/errors.json`;
        if (!existsSync(file)) return;
        let node: unknown = JSON.parse(readFileSync(file, 'utf8'));
        for (const part of key) node = (node as Record<string, unknown>)?.[part];
        expect({
          lang,
          messageKey,
          copy: typeof node === 'string' && node.length > 0,
        }).toEqual({
          lang,
          messageKey,
          copy: true,
        });
      }
    }

    it('GID-INVITE-01 — a valid invitation: joins invite-only B as the SAME user; A and A2 untouched; B’s own code (A6) applies', async () => {
      const { a, a2, b, person, sub, owner } = await ahmed('inv-ok');
      const before = await snapshot(person.userId);
      const inv = await invite(b.id, owner, { email: person.email });

      const res = await signUpWithGoogle(b, sub, person.email, inv.raw, 200);
      expect(res.body.emailOtpRequired).toBe(true); // A6: B's own code
      expect(res.body.accessToken).toBeUndefined();

      const after = await snapshot(person.userId);
      expect(after.users).toBe(1);
      expect(await admin.user.count({ where: { email: person.email } })).toBe(1);
      expect(after.staff).toEqual(before.staff); // instructor at A2, unchanged
      expect(after.students).toEqual(
        [
          { academyId: a.id, status: 'active', source: 'self_signup' },
          { academyId: b.id, status: 'active', source: 'invite' },
        ].sort((x, y) => x.academyId.localeCompare(y.academyId)),
      );
      expect(after.staff.map((r) => r.academyId)).toEqual([a2.id]);
      expect(
        (await admin.academyInvite.findUniqueOrThrow({ where: { id: inv.id } }))
          .usedCount,
      ).toBe(1);

      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', b.host)
        .send({
          challengeId: res.body.challengeId,
          code: await latestCode(person.userId),
          rememberDevice: false,
          surface: 'academy',
        })
        .expect(200);
      expect(session.body.authMethod).toBe('google');
      expect(await latestSessionMethod(person.userId)).toMatchObject({
        surface: 'academy',
        academyId: b.id,
        authMethod: 'google',
      });
    });

    it('GID-INVITE-02 — no code: inviteRequired; a wrong code: inviteInvalid (EN + AR copy); nothing joined', async () => {
      const { b, person, sub } = await ahmed('inv-none');
      const none = await signUpWithGoogle(b, sub, person.email, undefined, 403);
      expect(none.body.error.messageKey).toBe('errors.auth.inviteRequired');
      expectBilingualCopy('errors.auth.inviteRequired');

      const wrong = await signUpWithGoogle(
        b,
        sub,
        person.email,
        generateOpaqueToken(),
        400,
      );
      expect(wrong.body.error.messageKey).toBe('errors.auth.inviteInvalid');
      expectBilingualCopy('errors.auth.inviteInvalid');
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: b.id },
        }),
      ).toBe(0);
    });

    it('GID-INVITE-03 — refused: another academy’s code, expired, revoked, used up, addressed to someone else', async () => {
      const { b, person, sub, owner } = await ahmed('inv-bad');
      const c = await academy('inv-bad-c', 'invite');
      const cases = {
        foreignAcademy: await invite(c.id, owner, { email: person.email }),
        expired: await invite(b.id, owner, { expiresAt: new Date(Date.now() - 60_000) }),
        revoked: await invite(b.id, owner, { revokedAt: new Date() }),
        usedUp: await invite(b.id, owner, { maxUses: 1, usedCount: 1 }),
        otherAddress: await invite(b.id, owner, { email: 'someone-else@atlas.test' }),
      };
      for (const [label, inv] of Object.entries(cases)) {
        await flushRateLimitKeys();
        const res = await signUpWithGoogle(b, sub, person.email, inv.raw);
        expect({ label, status: res.status, key: res.body.error?.messageKey }).toEqual({
          label,
          status: 400,
          key: 'errors.auth.inviteInvalid',
        });
      }
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: b.id },
        }),
      ).toBe(0);
      // Nothing was spent by the refusals.
      expect(
        (await admin.academyInvite.findUniqueOrThrow({ where: { id: cases.usedUp.id } }))
          .usedCount,
      ).toBe(1);
      expect(
        (
          await admin.academyInvite.findUniqueOrThrow({
            where: { id: cases.foreignAcademy.id },
          })
        ).usedCount,
      ).toBe(0);
    });

    it('GID-INVITE-04 — already a learner at B: a used-up code is not needed or spent; the sign-in just continues', async () => {
      const { b, person, sub, owner } = await ahmed('inv-already');
      const inv = await invite(b.id, owner, { email: person.email });
      await signUpWithGoogle(b, sub, person.email, inv.raw, 200);
      expect(
        (await admin.academyInvite.findUniqueOrThrow({ where: { id: inv.id } }))
          .usedCount,
      ).toBe(1);

      // Same code again (now used up), and no code at all: both simply sign in.
      for (const token of [inv.raw, undefined]) {
        await flushRateLimitKeys();
        const res = await signUpWithGoogle(b, sub, person.email, token, 200);
        expect(res.body.emailOtpRequired ?? res.body.accessToken).toBeTruthy();
      }
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: b.id },
        }),
      ).toBe(1);
      expect(
        (await admin.academyInvite.findUniqueOrThrow({ where: { id: inv.id } }))
          .usedCount,
      ).toBe(1);
    });

    it('GID-INVITE-05 — the same account redeeming the same single-use code concurrently: exactly one membership, one use', async () => {
      const { b, person, sub, owner } = await ahmed('inv-race');
      const inv = await invite(b.id, owner, { email: person.email, maxUses: 1 });
      const one = await throughGoogle(
        b.host,
        { sub, email: person.email },
        { intent: 'sign_up' },
      );
      const two = await throughGoogle(
        b.host,
        { sub, email: person.email },
        { intent: 'sign_up' },
      );
      const results = await Promise.all(
        [one, two].map((f) =>
          http()
            .post('/auth/google/complete')
            .set('Host', b.host)
            .set('Cookie', f.binder)
            .send({ handoff: f.handoff, inviteToken: inv.raw }),
        ),
      );
      // One joins; the other either finds the account already a learner
      // (and signs in) or finds the code spent — never a second row.
      for (const r of results) expect([200, 400]).toContain(r.status);
      expect(results.some((r) => r.status === 200)).toBe(true);
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: b.id },
        }),
      ).toBe(1);
      expect(
        (await admin.academyInvite.findUniqueOrThrow({ where: { id: inv.id } }))
          .usedCount,
      ).toBe(1);
      expect(await admin.user.count({ where: { email: person.email } })).toBe(1);
    });

    it('GID-INVITE-06 — Case 4 at an invite-only academy: an instructor with a PASSWORD account links Google and redeems the code in the link step', async () => {
      const a = await academy('inv-c4-a');
      const b = await academy('inv-c4-b', 'invite');
      const staff = await staffAccount('inv-c4-instructor');
      await seedAcademyMember(admin, a.id, staff.userId, 'instructor');
      const owner = (
        await admin.academyMember.findFirstOrThrow({
          where: { academyId: b.id, role: 'owner' },
        })
      ).userId;
      const inv = await invite(b.id, owner, { email: staff.email });
      const { binder, step: s } = await toStep(
        b.host,
        { sub: newSub(), email: staff.email },
        { intent: 'sign_up' },
      );
      expect(s.googleStep).toBe('link_required');
      const res = await step('link', b.host, binder, {
        pending: s.pending,
        password: PASSWORD,
        inviteToken: inv.raw,
      }).expect(200);
      expect(res.body.emailOtpRequired).toBe(true);
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { userId: staff.userId },
      });
      expect(row).toMatchObject({ academyId: b.id, status: 'active', source: 'invite' });
      expect(
        await admin.academyMember.count({
          where: { userId: staff.userId, academyId: a.id, role: 'instructor' },
        }),
      ).toBe(1);
      expect(await admin.user.count({ where: { email: staff.email } })).toBe(1);
    });

    it('GID-INVITE-07 — a code addressed to the account’s Atlas email works even though the Google address differs', async () => {
      const { b, person, owner } = await ahmed('inv-addr');
      // Re-link this person's Google account with a DIFFERENT Google address.
      await admin.userAuthIdentity.deleteMany({ where: { userId: person.userId } });
      const sub = newSub();
      const googleEmail = uniqueTestEmail('inv-addr-google');
      await linkGoogle(person.userId, sub, googleEmail);
      const inv = await invite(b.id, owner, { email: person.email });
      await signUpWithGoogle(b, sub, googleEmail, inv.raw, 200);
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: b.id },
        }),
      ).toBe(1);

      // …and one addressed to the GOOGLE address is refused: invitations bind
      // to the Atlas account's email, as for the password join.
      const c = await academy('inv-addr-c', 'invite');
      const cOwner = (
        await admin.academyMember.findFirstOrThrow({
          where: { academyId: c.id, role: 'owner' },
        })
      ).userId;
      const googleAddressed = await invite(c.id, cOwner, { email: googleEmail });
      const refused = await signUpWithGoogle(
        c,
        sub,
        googleEmail,
        googleAddressed.raw,
        400,
      );
      expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');
    });
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
