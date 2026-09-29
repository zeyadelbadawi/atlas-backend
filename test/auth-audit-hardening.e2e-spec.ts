/**
 * Authentication comprehensive audit (docs/AUTHENTICATION_COMPREHENSIVE_AUDIT.md)
 * — regression tests for every fix, against real Postgres + Redis.
 *
 *   AUD-01  a TOTP challenge completes only the sign-in it was issued for
 *           (surface + academy + host), never one the verify body names;
 *   AUD-02  a password-reset link confirmed twice concurrently is honoured once;
 *   AUD-03  resetting or changing the password spends every other outstanding
 *           reset/setup link;
 *   AUD-04  password re-authentication (change password, 2FA disable, recovery
 *           codes) and reset confirmation are rate limited per account + IP;
 *   AUD-05  auth inputs are bounded (name, email, password, tokens, ids);
 *   AUD-06  a refresh for an account that is no longer active ends the session;
 *   AUD-07  a rotated refresh token replayed after the grace ends its family;
 *           within the grace (concurrent tabs) it only fails;
 *   AUD-08  malformed / oversized / Unicode / control-character input to every
 *           public auth endpoint is refused with 4xx, never a 5xx.
 */
import { sessionTokenFrom } from './utils/session-cookie';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';
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
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../src/identity/utils/opaque-token.util';
import type { IdentityConfig } from '../src/config/configuration';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';

jest.setTimeout(240000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-audit';
const BASE = 'authaudit.test';

const ENV_KEYS = [
  'PLATFORM_BASE_DOMAIN',
  'FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY',
  'FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT',
] as const;

describe('Authentication audit hardening (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let limit: number;

  beforeAll(async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      PLATFORM_BASE_DOMAIN: BASE,
      FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: 'off',
      FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT: 'off',
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
    limit = app.get(ConfigService).getOrThrow<IdentityConfig>('identity')
      .signInRateLimit.max;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());

  async function register(label: string, host = BASE) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', host)
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  function signIn(email: string, host = BASE, extra: Record<string, unknown> = {}) {
    return http()
      .post('/auth/sign-in')
      .set('Host', host)
      .send({ email, password: PASSWORD, ...extra });
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
    return { id: a.id, host, owner };
  }

  async function enrollTotp(email: string): Promise<string> {
    const session = await signIn(email).expect(200);
    const token = session.body.accessToken as string;
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
    return secret;
  }

  async function resetLink(userId: string): Promise<string> {
    const raw = generateOpaqueToken();
    await admin.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashOpaqueToken(raw),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    return raw;
  }

  // ==================================================================
  // AUD-01 — TOTP challenge bound to its sign-in
  // ==================================================================

  it('AUD-01 — a TOTP challenge from academy A cannot be completed as management or on academy B; on A it yields the A session', async () => {
    const a = await academy('aud01-a');
    const b = await academy('aud01-b');
    // The owner of A is staff there (academy sign-in allowed) and a
    // management user; it has TOTP.
    const secret = await enrollTotp(a.owner.email);
    await flush();
    const started = await signIn(a.owner.email, a.host, {
      surface: 'academy',
      academyId: a.id,
    }).expect(200);
    expect(started.body.twoFactorRequired).toBe(true);
    const challengeId = started.body.challengeId as string;
    const code = async () =>
      generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

    // Completed on the platform host, even naming management: refused.
    await http()
      .post('/auth/2fa/verify')
      .set('Host', BASE)
      .send({ challengeId, token: await code(), surface: 'management' })
      .expect(401);
    // Completed on academy B's host: refused.
    await http()
      .post('/auth/2fa/verify')
      .set('Host', b.host)
      .send({ challengeId, token: await code(), surface: 'academy', academyId: b.id })
      .expect(401);
    // On A's own host, whatever the body says, the session is A's.
    const done = await http()
      .post('/auth/2fa/verify')
      .set('Host', a.host)
      .send({ challengeId, token: await code(), surface: 'management' })
      .expect(200);
    const row = await admin.refreshToken.findFirstOrThrow({
      where: { userId: a.owner.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(done.body.accessToken).toEqual(expect.any(String));
    expect(row).toMatchObject({ surface: 'academy', academyId: a.id });
  });

  // ==================================================================
  // AUD-02 / AUD-03 — reset links
  // ==================================================================

  it('AUD-02 — one reset link confirmed twice at once sets the password exactly once', async () => {
    const person = await register('aud02');
    const raw = await resetLink(person.userId);
    const results = await Promise.all(
      ['first-new-password-1', 'second-new-password-2'].map((newPassword) =>
        http().post('/auth/password-reset/confirm').send({ token: raw, newPassword }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const winner = results.find((r) => r.status === 200)!;
    const winnerPassword =
      winner === results[0] ? 'first-new-password-1' : 'second-new-password-2';
    await flush();
    await http()
      .post('/auth/sign-in')
      .send({ email: person.email, password: winnerPassword })
      .expect(200);
  });

  it('AUD-03 — a reset spends every other outstanding link; a password change spends them too', async () => {
    const person = await register('aud03');
    const first = await resetLink(person.userId);
    const second = await resetLink(person.userId);
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: first, newPassword: 'reset-password-aud03' })
      .expect(200);
    await http()
      .post('/auth/password-reset/validate')
      .send({ token: second })
      .expect(200)
      .expect((r) => expect(r.body.valid).toBe(false));
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: second, newPassword: 'attacker-password-aud03' })
      .expect(401);

    const other = await register('aud03-change');
    const pending = await resetLink(other.userId);
    const session = await signIn(other.email).expect(200);
    await http()
      .post('/users/me/password')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'changed-password-aud03' })
      .expect(200);
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: pending, newPassword: 'attacker-password-aud03' })
      .expect(401);
  });

  // ==================================================================
  // AUD-04 — re-authentication is rate limited
  // ==================================================================

  it('AUD-04 — guessing the current password with a session is throttled (change password, 2FA disable, recovery codes)', async () => {
    const person = await register('aud04');
    const session = await signIn(person.email).expect(200);
    const bearer = `Bearer ${session.body.accessToken}`;
    for (let i = 0; i < limit; i += 1) {
      await http()
        .post('/users/me/password')
        .set('Authorization', bearer)
        .send({ currentPassword: `wrong-${i}-password`, newPassword: 'whatever-new-1' })
        .expect(401);
    }
    const blocked = await http()
      .post('/users/me/password')
      .set('Authorization', bearer)
      .send({ currentPassword: PASSWORD, newPassword: 'whatever-new-1' })
      .expect(429);
    expect(blocked.body.error.messageKey).toBe('errors.auth.rateLimited');
    // The same account budget covers the other password-gated actions.
    await http()
      .post('/auth/2fa/disable')
      .set('Authorization', bearer)
      .send({ password: 'wrong-password' })
      .expect(429);
    await http()
      .post('/auth/2fa/recovery-codes')
      .set('Authorization', bearer)
      .send({ password: 'wrong-password' })
      .expect(429);
    // Sign-in itself is a different budget: still works.
    await signIn(person.email).expect(200);
  });

  it('AUD-04b — reset confirmation is rate limited per IP', async () => {
    for (let i = 0; i < limit; i += 1) {
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: generateOpaqueToken(), newPassword: 'some-new-password' })
        .expect(401);
    }
    await http()
      .post('/auth/password-reset/confirm')
      .send({ token: generateOpaqueToken(), newPassword: 'some-new-password' })
      .expect(429);
  });

  // ==================================================================
  // AUD-05 — bounded inputs
  // ==================================================================

  it('AUD-05 — oversized names, emails, passwords and tokens are refused with 400 and create nothing', async () => {
    const email = uniqueTestEmail('aud05');
    await http()
      .post('/auth/register')
      .send({ name: 'x'.repeat(101), email, password: PASSWORD })
      .expect(400);
    await http()
      .post('/auth/register')
      .send({ name: 'Valid Name', email, password: 'p'.repeat(1025) })
      .expect(400);
    await http()
      .post('/auth/register')
      .send({
        name: 'Valid Name',
        email: `${'a'.repeat(250)}@example.com`,
        password: PASSWORD,
      })
      .expect(400);
    expect(await admin.user.count({ where: { email } })).toBe(0);
    // Exactly at the bound is accepted (Arabic counts by characters).
    await http()
      .post('/auth/register')
      .send({ name: 'ع'.repeat(100), email, password: PASSWORD })
      .expect(201);
    await http()
      .post('/auth/sign-in')
      .send({ email, password: 'p'.repeat(1025) })
      .expect(400);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: 'r'.repeat(513) })
      .expect(400);
  });

  // ==================================================================
  // AUD-06 / AUD-07 — refresh
  // ==================================================================

  it('AUD-06 — a refresh for a suspended account ends the session instead of renewing it', async () => {
    const person = await register('aud06');
    const session = await signIn(person.email).expect(200);
    await admin.user.update({
      where: { id: person.userId },
      data: { status: 'suspended' },
    });
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: sessionTokenFrom(session) })
      .expect(401);
    expect(
      await admin.refreshToken.count({
        where: { userId: person.userId, revokedAt: null },
      }),
    ).toBe(0);
    // The access token is denied at once, too.
    await http()
      .get('/auth/validate')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .expect(401);
  });

  it('AUD-07 — a rotated refresh token replayed after the grace ends the whole session; within the grace it only fails', async () => {
    const person = await register('aud07');
    const session = await signIn(person.email).expect(200);
    const first = sessionTokenFrom(session) as string;
    const rotated = await http()
      .post('/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = sessionTokenFrom(rotated) as string;

    // A concurrent tab presenting the old token a moment later: 401, but the
    // session lives on.
    await http().post('/auth/refresh').send({ refreshToken: first }).expect(401);
    const third = sessionTokenFrom(
      await http().post('/auth/refresh').send({ refreshToken: second }).expect(200),
    ) as string;

    // The same old token presented after the grace: the family ends.
    await admin.refreshToken.update({
      where: { tokenHash: hashOpaqueToken(first) },
      data: { revokedAt: new Date(Date.now() - 5 * 60 * 1000) },
    });
    await http().post('/auth/refresh').send({ refreshToken: first }).expect(401);
    await http().post('/auth/refresh').send({ refreshToken: third }).expect(401);
    await http()
      .get('/auth/validate')
      .set('Authorization', `Bearer ${rotated.body.accessToken}`)
      .expect(401);
    const audit = await admin.auditLogEntry.findFirst({
      where: { actorUserId: person.userId, action: 'auth.sessions.revoked' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit?.context).toMatchObject({ trigger: 'refresh_token_reuse' });
    // And it is visible to alerting: the revocation counter carries the trigger.
    const revoked = await METRICS_REGISTRY.getSingleMetric(
      'atlas_auth_sessions_revoked_total',
    )!.get();
    expect(
      revoked.values.find((v) => v.labels.trigger === 'refresh_token_reuse')?.value ?? 0,
    ).toBeGreaterThanOrEqual(1);
    // A fresh sign-in is unaffected.
    await signIn(person.email).expect(200);
  });

  // ==================================================================
  // AUD-08 — malformed input never reaches a 5xx
  // ==================================================================

  it('AUD-08 — malformed, oversized, Unicode and control-character input to public auth endpoints is a 4xx', async () => {
    const person = await register('aud08');
    const session = await signIn(person.email).expect(200);
    const bearer = `Bearer ${session.body.accessToken}`;
    const weird = [
      'not-a-uuid',
      "' OR 1=1 --",
      '<script>alert(1)</script>',
      '../../etc/passwd',
      'ع'.repeat(50),
      '\u0000\u0007\u001b[31m',
      '💥'.repeat(20),
      '__proto__',
    ];
    const cases: [string, string, Record<string, unknown>][] = [];
    for (const v of weird) {
      cases.push(['post', '/auth/sign-in', { email: v, password: v }]);
      cases.push([
        'post',
        '/auth/sign-in',
        { email: person.email, password: 'x', surface: 'academy', academyId: v },
      ]);
      cases.push([
        'post',
        '/auth/register',
        { name: v, email: v, password: v, academyId: v },
      ]);
      cases.push([
        'post',
        '/auth/academy-join',
        { email: person.email, password: v, academyId: v },
      ]);
      cases.push(['post', '/auth/refresh', { refreshToken: v }]);
      cases.push(['post', '/auth/password-reset/request', { email: v }]);
      cases.push(['post', '/auth/password-reset/validate', { token: v }]);
      cases.push(['post', '/auth/verify-email', { token: v }]);
      cases.push([
        'post',
        '/auth/otp/verify',
        { challengeId: v, code: v, rememberDevice: false },
      ]);
      cases.push(['post', '/auth/otp/resend', { challengeId: v }]);
      cases.push([
        'post',
        '/auth/2fa/verify',
        { challengeId: v, token: '123456', surface: 'academy', academyId: v },
      ]);
      cases.push(['post', '/auth/google/complete', { handoff: v }]);
      cases.push(['post', '/auth/google/link', { pending: v, password: v }]);
    }
    cases.push(['post', '/auth/sign-in', { email: ['a@b.c'], password: { $gt: '' } }]);
    cases.push([
      'post',
      '/auth/sign-in',
      { __proto__: { admin: true }, email: 'a@b.c', password: 'x' },
    ]);
    const failures: string[] = [];
    for (const [method, path, body] of cases) {
      await flush();
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set('Host', BASE)
        .send(body);
      if (res.status >= 500)
        failures.push(`${res.status} ${path} ${JSON.stringify(body).slice(0, 80)}`);
    }
    // Authenticated routes with a hostile id.
    for (const v of weird) {
      for (const path of [
        `/auth/sessions/${encodeURIComponent(v)}`,
        `/auth/trusted-devices/${encodeURIComponent(v)}`,
      ]) {
        const res = await http()
          .delete(path)
          .set('Host', BASE)
          .set('Authorization', bearer);
        if (res.status >= 500) failures.push(`${res.status} DELETE ${path}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
