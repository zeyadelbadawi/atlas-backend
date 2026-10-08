/**
 * Google Identity — Atlas's own sign-in and sign-up (the platform host,
 * i.e. the MANAGEMENT surface) under the production rollout shape:
 * `FLAG_AUTH_GOOGLE_MODE=allowlist` with an academy allowlist, plus the
 * separate `FLAG_AUTH_GOOGLE_PLATFORM` switch; organization sign-up on;
 * the management emailed code on (`new_device`). Real Postgres as
 * `atlas_app` (RLS), a fake Google.
 *
 *   - the platform switch is independent: it turns the platform on or off
 *     without touching the academy allowlist, and never enables an
 *     unlisted academy;
 *   - a NEW Google user on the platform gets the create step and nothing
 *     else; the organization name and plan are validated by the SAME
 *     canonical signup (a refused value keeps the step open); success is
 *     ONE user + identity + organization (pending onboarding) + owner
 *     membership + trialing subscription on the chosen plan, atomically;
 *   - the account then goes through the normal pipeline: the management
 *     emailed code before any session; the session says `google`;
 *   - an existing password account with the same address must prove its
 *     password (no auto-link); a wrong one links nothing;
 *   - a linked account signs in normally; TOTP, suspension and deletion
 *     are never bypassed; cancel, replay and one-sub-one-user hold.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
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
import type { GoogleAuthConfig, IdentityConfig } from '../src/config/configuration';
import { TrialPolicyRepository } from '../src/plans/repositories/trial-policy.repository';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { uniqueName } from './utils/unique-name';

// W4 — organization names are unique platform-wide and the e2e DB persists.
const NILE_LEARNING = uniqueName('Nile Learning');

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-gplat';
const CLIENT_ID = 'atlas-plat-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'atlas-plat-client-secret-never-logged';
/** The platform (management) host: `PLATFORM_BASE_DOMAIN` itself. */
const BASE = 'gidplat.test';
const REDIRECT_URI = `http://${BASE}/auth/google/callback`;

const ENV_KEYS = [
  'PLATFORM_BASE_DOMAIN',
  'FLAG_AUTH_GOOGLE_MODE',
  'FLAG_AUTH_GOOGLE_ACADEMY_IDS',
  'FLAG_AUTH_GOOGLE_PLATFORM',
  'FLAG_SIGNUP_ORGANIZATION_MODE',
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

describe('Google Identity — Atlas platform sign-in / sign-up (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let google: FakeGoogleOidc;
  let flushRateLimitKeys: () => Promise<void>;
  /** The live config objects the services read on every request. */
  let googleConfig: { academyIds: string[]; platform: boolean };
  let identityConfig: {
    signupOrganizationMode: IdentityConfig['signupOrganizationMode'];
  };
  let trialPlan: Plan;
  let originalPolicy: { enabled: boolean; durationDays: number };

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
      FLAG_AUTH_GOOGLE_MODE: 'allowlist',
      FLAG_AUTH_GOOGLE_PLATFORM: 'on',
      FLAG_SIGNUP_ORGANIZATION_MODE: 'on',
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
    const config = app.get(ConfigService);
    googleConfig = config.getOrThrow<GoogleAuthConfig>('googleAuth') as never;
    identityConfig = config.getOrThrow<IdentityConfig>('identity') as never;
    expect(googleConfig.platform).toBe(true);
    expect(identityConfig.signupOrganizationMode).toBe('on');

    const policy = await app.get(TrialPolicyRepository).findSingleton();
    originalPolicy = { enabled: policy.enabled, durationDays: policy.durationDays };
    await admin.trialPolicy.updateMany({ data: { enabled: true, durationDays: 3 } });
    trialPlan = await admin.plan.create({
      data: {
        key: `gplat-trial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: 'gplat-trial',
        status: 'active',
        displayOrder: 900,
        trialEligible: true,
        limits: {
          academies: 2,
          students: 50,
          instructors: 5,
          staff: 5,
          courses: 20,
          generalStorage: 10,
          videoStorage: 10,
        },
        features: { liveSessions: false },
        pricing: { amount: 49, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  });

  afterAll(async () => {
    // Customer-facing fixture plans would linger in later catalog reads.
    await admin.plan.updateMany({
      where: { key: { startsWith: 'gplat-' } },
      data: { status: 'archived' },
    });
    await admin.trialPolicy.updateMany({ data: originalPolicy });
    await admin.$disconnect();
    await app.close();
    await google.stop();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
    googleConfig.platform = true;
    identityConfig.signupOrganizationMode = 'on';
  });

  // ------------------------------------------------------------------
  // fixtures
  // ------------------------------------------------------------------

  const http = () => request(app.getHttpServer());
  const newSub = () => `gp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function register(label: string, extra: Record<string, unknown> = {}) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', BASE)
      .send({ name: label, email, password: PASSWORD, ...extra })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function academy(label: string) {
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

  const fragmentOf = (location: string) =>
    new URLSearchParams(location.split('#')[1] ?? '');

  async function authorize(host: string, body: Record<string, unknown>) {
    const res = await http()
      .post('/auth/google/authorize')
      .set('Host', host)
      .send(body)
      .expect(200);
    return {
      authorizationUrl: res.body.authorizationUrl as string,
      binder: binderFrom(res),
    };
  }

  const callback = (query: Record<string, string>) =>
    http().get('/auth/google/callback').set('Host', BASE).query(query);

  /** Atlas's sign-up (or sign-in) page → Google → the callback → the handoff. */
  async function throughGoogle(
    signIn: Parameters<FakeGoogleOidc['approve']>[1],
    intent: 'sign_in' | 'sign_up' = 'sign_up',
  ) {
    const started = await authorize(BASE, { intent, returnTo: '/auth/register' });
    const { code, state } = google.approve(started.authorizationUrl, signIn);
    const res = await callback({ code, state }).expect(303);
    return {
      ...started,
      code,
      state,
      location: res.headers.location as string,
      handoff: fragmentOf(res.headers.location).get('h') ?? '',
    };
  }

  const complete = (handoff: string, binder?: string) => {
    const req = http().post('/auth/google/complete').set('Host', BASE).send({ handoff });
    return binder ? req.set('Cookie', binder) : req;
  };

  const step = (path: string, binder: string, body: Record<string, unknown>) =>
    http()
      .post(`/auth/google/${path}`)
      .set('Host', BASE)
      .set('Cookie', binder)
      .send(body);

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

  const finishCode = async (userId: string, challengeId: string) =>
    http()
      .post('/auth/otp/verify')
      .set('Host', BASE)
      .send({
        challengeId,
        code: await latestCode(userId),
        rememberDevice: false,
        surface: 'management',
      })
      .expect(200);

  /** A management session by password (completing the emailed code). */
  async function passwordSession(email: string, userId: string) {
    const res = await http()
      .post('/auth/sign-in')
      .set('Host', BASE)
      .send({ email, password: PASSWORD, surface: 'management' })
      .expect(200);
    if (res.body.accessToken) return res.body.accessToken as string;
    return (await finishCode(userId, res.body.challengeId)).body.accessToken as string;
  }

  const sessionRows = (userId: string) => admin.refreshToken.count({ where: { userId } });

  // ==================================================================
  // Rollout: the platform switch
  // ==================================================================

  it('GPLAT-FLAG-01 — allowlist + platform on: Atlas offers Google, listed academies do, unlisted do not; the switch alone turns the platform off', async () => {
    const listed = await academy('gplat-listed');
    const other = await academy('gplat-other');
    googleConfig.academyIds = [listed.id];

    const options = async (host: string) =>
      (await http().get('/auth/options').set('Host', host).expect(200)).body;
    expect(await options(BASE)).toEqual({ google: true });
    expect(await options(listed.host)).toEqual({ google: true });
    expect(await options(other.host)).toEqual({ google: false });
    await authorize(BASE, { intent: 'sign_in' });
    await authorize(BASE, { intent: 'sign_up' });
    await authorize(listed.host, { intent: 'sign_in' });
    await http()
      .post('/auth/google/authorize')
      .set('Host', other.host)
      .send({ intent: 'sign_in' })
      .expect(404);

    // Platform off: the platform goes dark; the academy allowlist is untouched.
    googleConfig.platform = false;
    expect(await options(BASE)).toEqual({ google: false });
    await http()
      .post('/auth/google/authorize')
      .set('Host', BASE)
      .send({ intent: 'sign_in' })
      .expect(404);
    expect(await options(listed.host)).toEqual({ google: true });
    expect(await options(other.host)).toEqual({ google: false });
  });

  // ==================================================================
  // A new Google user on Atlas's sign-up
  // ==================================================================

  it('GPLAT-NEW-01 — create step only; organization name and plan validated by the canonical signup (step stays open); then ONE user + identity + organization + owner + trial on the chosen plan; the emailed code before any session', async () => {
    const email = uniqueTestEmail('gplat-new');
    const sub = newSub();
    const flow = await throughGoogle({ sub, email, name: 'Nour Owner' });
    // Nothing about the sign-up ever travels in a URL.
    expect(flow.authorizationUrl).not.toMatch(/organization|plan/i);
    expect(flow.location).not.toMatch(/organization|plan/i);

    const stepRes = await complete(flow.handoff, flow.binder).expect(200);
    expect(stepRes.body).toMatchObject({
      googleStep: 'create_account',
      email,
      name: 'Nour Owner',
    });
    expect(await admin.user.count({ where: { email } })).toBe(0);
    const pending = stepRes.body.pending as string;

    // Plan without an organization name → refused, nothing created, step open.
    const noName = await step('create-account', flow.binder, {
      pending,
      name: 'Nour Owner',
      planId: trialPlan.id,
    }).expect(400);
    expect(noName.body.error.messageKey).toBe('errors.auth.organizationNameRequired');
    // An unknown plan → refused by the catalog, nothing created, step open.
    await step('create-account', flow.binder, {
      pending,
      name: 'Nour Owner',
      organizationName: NILE_LEARNING,
      planId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
    expect(await admin.user.count({ where: { email } })).toBe(0);
    expect(await admin.userAuthIdentity.count({ where: { providerSubject: sub } })).toBe(
      0,
    );

    const created = await step('create-account', flow.binder, {
      pending,
      name: 'Nour Owner',
      organizationName: NILE_LEARNING,
      planId: trialPlan.id,
    }).expect(201);
    // Google replaced the password only: the management emailed code (new
    // browser) is asked before any session exists.
    expect(created.body.emailOtpRequired).toBe(true);
    expect(created.body.accessToken).toBeUndefined();

    const users = await admin.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    const user = users[0];
    expect(user.status).toBe('active');
    expect(await admin.userCredential.count({ where: { userId: user.id } })).toBe(0);
    expect(await sessionRows(user.id)).toBe(0);
    const identities = await admin.userAuthIdentity.findMany({
      where: { providerSubject: sub },
    });
    expect(identities).toHaveLength(1);
    expect(identities[0].userId).toBe(user.id);

    const orgs = await admin.organization.findMany({ where: { ownerUserId: user.id } });
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe(NILE_LEARNING);
    // A signup organization starts with its onboarding open.
    expect(orgs[0].onboardingCompletedAt).toBeNull();
    const membership = await admin.organizationMembership.findFirstOrThrow({
      where: { organizationId: orgs[0].id, userId: user.id },
    });
    expect(membership).toMatchObject({ role: 'owner', isPrimary: true });
    const subscription = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgs[0].id },
    });
    expect(subscription).toMatchObject({ status: 'trialing', planId: trialPlan.id });

    const session = await finishCode(user.id, created.body.challengeId);
    expect(session.body.authMethod).toBe('google');
    expect(session.body.user.id).toBe(user.id);
    const organizations = session.body.user.organizations as {
      organizationId: string;
      role: string;
      onboardingPending: boolean;
    }[];
    expect(organizations).toEqual([
      expect.objectContaining({
        organizationId: orgs[0].id,
        role: 'owner',
        onboardingPending: true,
      }),
    ]);
    const row = await admin.refreshToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).toMatchObject({ authMethod: 'google', surface: 'management' });

    // The step is spent: replaying it creates nothing.
    await step('create-account', flow.binder, {
      pending,
      name: 'Nour Owner',
      organizationName: NILE_LEARNING,
      planId: trialPlan.id,
    }).expect(401);
    // The handoff and the callback are single-use too.
    await complete(flow.handoff, flow.binder).expect(401);
    await callback({ code: flow.code, state: flow.state }).expect(400);
    expect(await admin.user.count({ where: { email } })).toBe(1);
    expect(await admin.organization.count({ where: { ownerUserId: user.id } })).toBe(1);

    // The same Google account again, from the SIGN-IN page: the same user,
    // no create step, no second account or organization.
    const again = await throughGoogle({ sub, email }, 'sign_in');
    const signedIn = await complete(again.handoff, again.binder).expect(200);
    expect(signedIn.body.googleStep).toBeUndefined();
    expect(signedIn.body.emailOtpRequired).toBe(true);
    const second = await finishCode(user.id, signedIn.body.challengeId);
    expect(second.body.user.id).toBe(user.id);
    expect(await admin.user.count({ where: { email } })).toBe(1);
    expect(await admin.organization.count({ where: { ownerUserId: user.id } })).toBe(1);
  });

  it('GPLAT-NEW-02 — the organization fields follow the SAME rules as the password sign-up (parity, flag off refused)', async () => {
    identityConfig.signupOrganizationMode = 'off';
    const email = uniqueTestEmail('gplat-flagoff');
    const flow = await throughGoogle({ sub: newSub(), email });
    const { pending } = (await complete(flow.handoff, flow.binder).expect(200)).body;
    const refused = await step('create-account', flow.binder, {
      pending,
      name: 'Owner',
      organizationName: NILE_LEARNING,
      planId: trialPlan.id,
    }).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.organizationSignupDisabled');
    expect(await admin.user.count({ where: { email } })).toBe(0);

    // The password sign-up answers the same request identically.
    const password = await http()
      .post('/auth/register')
      .set('Host', BASE)
      .send({
        name: 'Owner',
        email: uniqueTestEmail('gplat-flagoff-pw'),
        password: PASSWORD,
        organizationName: NILE_LEARNING,
        planId: trialPlan.id,
      })
      .expect(400);
    expect(password.body.error.messageKey).toBe('errors.auth.organizationSignupDisabled');
  });

  // ==================================================================
  // Existing accounts
  // ==================================================================

  it('GPLAT-LINK-01 — an existing password owner with the same address: password proof required (wrong one links nothing), then the SAME user, organization kept, emailed code, google session', async () => {
    const owner = await register('gplat-link', {
      organizationName: uniqueName('Existing Org'),
      planId: trialPlan.id,
    });
    const orgsBefore = await admin.organization.findMany({
      where: { ownerUserId: owner.userId },
      select: { id: true },
    });
    expect(orgsBefore).toHaveLength(1);
    const sub = newSub();
    const flow = await throughGoogle({ sub, email: owner.email });
    const stepRes = await complete(flow.handoff, flow.binder).expect(200);
    // An address match is a question, never an answer.
    expect(stepRes.body.googleStep).toBe('link_required');
    expect(await admin.userAuthIdentity.count({ where: { providerSubject: sub } })).toBe(
      0,
    );

    const wrong = await step('link', flow.binder, {
      pending: stepRes.body.pending,
      password: 'not-the-password',
    }).expect(401);
    expect(wrong.body.error.messageKey).toBe('errors.auth.invalidCredentials');
    expect(await admin.userAuthIdentity.count({ where: { providerSubject: sub } })).toBe(
      0,
    );
    expect(await sessionRows(owner.userId)).toBe(0);

    const linked = await step('link', flow.binder, {
      pending: stepRes.body.pending,
      password: PASSWORD,
    }).expect(200);
    expect(linked.body.emailOtpRequired).toBe(true);
    const identity = await admin.userAuthIdentity.findFirstOrThrow({
      where: { providerSubject: sub },
    });
    expect(identity.userId).toBe(owner.userId);
    const session = await finishCode(owner.userId, linked.body.challengeId);
    expect(session.body.authMethod).toBe('google');
    expect(session.body.user.id).toBe(owner.userId);
    expect(await admin.user.count({ where: { email: owner.email } })).toBe(1);
    expect(
      await admin.organization.findMany({
        where: { ownerUserId: owner.userId },
        select: { id: true },
      }),
    ).toEqual(orgsBefore);

    // The password still works afterwards.
    expect(await passwordSession(owner.email, owner.userId)).toEqual(expect.any(String));
  });

  it('GPLAT-PIPE-01 — a TOTP-enrolled owner: Google never skips TOTP on the platform', async () => {
    const owner = await register('gplat-totp');
    const token = await passwordSession(owner.email, owner.userId);
    const setup = await http()
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const secret = setup.body.secret as string;
    await http()
      .post('/auth/2fa/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: await generate({ secret }), password: PASSWORD })
      .expect(200);
    const sub = newSub();
    await linkGoogle(owner.userId, sub, owner.email);

    const before = await sessionRows(owner.userId);
    const flow = await throughGoogle({ sub, email: owner.email }, 'sign_in');
    const challenge = await complete(flow.handoff, flow.binder).expect(200);
    expect(challenge.body).toMatchObject({ twoFactorRequired: true });
    expect(challenge.body.accessToken).toBeUndefined();
    expect(await sessionRows(owner.userId)).toBe(before);

    const done = await http()
      .post('/auth/2fa/verify')
      .set('Host', BASE)
      .send({
        challengeId: challenge.body.challengeId,
        token: await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 }),
        surface: 'management',
      })
      .expect(200);
    expect(done.body.authMethod).toBe('google');
    expect(await sessionRows(owner.userId)).toBe(before + 1);
  });

  it('GPLAT-PIPE-02 — suspended and deleted accounts are refused on the platform, with no session', async () => {
    const suspended = await register('gplat-susp');
    const suspendedSub = newSub();
    await linkGoogle(suspended.userId, suspendedSub, suspended.email);
    await admin.user.update({
      where: { id: suspended.userId },
      data: { status: 'suspended' },
    });
    const s = await throughGoogle(
      { sub: suspendedSub, email: suspended.email },
      'sign_in',
    );
    const refused = await complete(s.handoff, s.binder).expect(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.accountSuspended');
    expect(await sessionRows(suspended.userId)).toBe(0);

    const deleted = await register('gplat-del');
    const deletedSub = newSub();
    await linkGoogle(deleted.userId, deletedSub, deleted.email);
    await admin.user.update({
      where: { id: deleted.userId },
      data: { status: 'deleted' },
    });
    const d = await throughGoogle({ sub: deletedSub, email: deleted.email }, 'sign_in');
    const res = await complete(d.handoff, d.binder);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.googleStep).toBeUndefined();
    expect(await sessionRows(deleted.userId)).toBe(0);
    expect(await admin.user.count({ where: { email: deleted.email } })).toBe(1);
  });

  it('GPLAT-CANCEL-01 — cancelling at Google returns to the platform page with #error=cancelled; nothing is created', async () => {
    const started = await authorize(BASE, {
      intent: 'sign_up',
      returnTo: '/auth/register',
    });
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const res = await callback({ state, error: 'access_denied' }).expect(303);
    const location = res.headers.location as string;
    expect(location.startsWith(`http://${BASE}/auth/google/return#`)).toBe(true);
    expect(fragmentOf(location).get('error')).toBe('cancelled');
    expect(fragmentOf(location).get('h')).toBeNull();
    // The flow is finished: its state cannot be used again.
    await callback({ state, code: 'late-code' }).expect(400);
  });

  it('GPLAT-ONE-01 — one Google account belongs to one Atlas user: a second account cannot take it', async () => {
    const first = await register('gplat-one-a');
    const sub = newSub();
    await linkGoogle(first.userId, sub, first.email);
    // Someone with a DIFFERENT, new address presents the same Google subject
    // (Google renamed the address): it signs into the owner, never creates.
    const renamed = uniqueTestEmail('gplat-one-renamed');
    const flow = await throughGoogle({ sub, email: renamed });
    const res = await complete(flow.handoff, flow.binder).expect(200);
    expect(res.body.googleStep).toBeUndefined();
    expect(res.body.emailOtpRequired).toBe(true);
    expect(await admin.user.count({ where: { email: renamed } })).toBe(0);
    expect(await admin.userAuthIdentity.count({ where: { providerSubject: sub } })).toBe(
      1,
    );
  });
});
