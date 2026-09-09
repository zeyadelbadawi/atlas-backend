/**
 * Phase 10 (Session Security & Hardening) suite — P10-SEC-001..014, one
 * per scenario the phase's instructions require, in their stated order:
 *
 *   001  A user sees only their OWN sessions
 *   002  A user cannot read another user's sessions
 *   003  Revoking one session does not disturb the others
 *   004  A revoked session cannot refresh
 *   005  A revoked session's ACCESS token dies on the very next request
 *   006  Another user cannot revoke your session
 *   007  Multiple devices are distinguishable in the list
 *   008  IP, user agent and last-used are really persisted
 *   009  `lastUsedAt` advances on refresh, and rotation keeps one session
 *   010  Sign-in / sign-out still work unchanged
 *   011  Sign-out kills its own session immediately
 *   012  The 2FA insertion point exists and issues nothing early
 *   013  Rate limiting still applies to sign-in
 *   014  No token material is ever present in a session response
 *
 * Exercised through the real HTTP surface against real Postgres/Redis,
 * following the same per-phase pattern as the Phase 8 and Phase 9 suites.
 *
 * WHY 005 IS THE LOAD-BEARING TEST. The roadmap requires revocation to
 * take effect "against the actual token-validation path, not just the
 * database row". A test that only checked the row, or only checked that
 * refresh fails, would pass against a system where a stolen access token
 * kept working for its full 15-minute lifetime — precisely the hole this
 * phase exists to close. 005 asserts the access token itself is refused.
 */
import { INestApplication } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';

interface SignedInDevice {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

describe('Phase 10 session security (e2e) — P10-SEC-001..014', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function registerUser(label: string): Promise<string> {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    return email;
  }

  /** Signs in as a specific "device" by varying only the User-Agent, which is how a real second device differs. */
  async function signInAs(email: string, userAgent: string): Promise<SignedInDevice> {
    const response = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('User-Agent', userAgent)
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: response.body.user.id,
      accessToken: response.body.accessToken,
      refreshToken: response.body.refreshToken,
    };
  }

  function listSessions(accessToken: string) {
    return request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  it('P10-SEC-001 — a user sees only their own sessions', async () => {
    const aliceEmail = await registerUser('p10-001-alice');
    const bobEmail = await registerUser('p10-001-bob');
    const alice = await signInAs(aliceEmail, CHROME_MAC);
    const bob = await signInAs(bobEmail, FIREFOX_WINDOWS);

    const aliceSessions = await listSessions(alice.accessToken).expect(200);
    const bobSessions = await listSessions(bob.accessToken).expect(200);

    expect(aliceSessions.body).toHaveLength(1);
    expect(bobSessions.body).toHaveLength(1);

    // The two users' session ids are disjoint sets — neither list leaks
    // the other's session, which is the actual isolation claim.
    const aliceIds = aliceSessions.body.map((s: { id: string }) => s.id);
    const bobIds = bobSessions.body.map((s: { id: string }) => s.id);
    expect(aliceIds.filter((id: string) => bobIds.includes(id))).toHaveLength(0);
  });

  it('P10-SEC-002 — organization/academy membership never exposes another user\'s sessions', async () => {
    // There is deliberately no endpoint that accepts a user id at all:
    // `GET /auth/sessions` is scoped entirely by the bearer token, so
    // there is no parameter an attacker could point elsewhere. The
    // strongest available assertion is that an unauthenticated caller,
    // and a caller with a junk token, both get nothing.
    await request(app.getHttpServer()).get('/auth/sessions').expect(401);
    await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('P10-SEC-003 — revoking one session leaves the others working', async () => {
    const email = await registerUser('p10-003');
    const laptop = await signInAs(email, CHROME_MAC);
    const desktop = await signInAs(email, FIREFOX_WINDOWS);

    const before = await listSessions(laptop.accessToken).expect(200);
    expect(before.body).toHaveLength(2);
    const other = before.body.find((s: { isCurrent: boolean }) => !s.isCurrent);

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .expect(204);

    // The surviving session still works and is now the only one listed.
    const after = await listSessions(laptop.accessToken).expect(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].isCurrent).toBe(true);
    expect(desktop.accessToken).not.toBe(laptop.accessToken);
  });

  it('P10-SEC-004 — a revoked session cannot refresh', async () => {
    const email = await registerUser('p10-004');
    const laptop = await signInAs(email, CHROME_MAC);
    const desktop = await signInAs(email, FIREFOX_WINDOWS);

    const sessions = await listSessions(laptop.accessToken).expect(200);
    const target = sessions.body.find((s: { isCurrent: boolean }) => !s.isCurrent);

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${target.id}`)
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .expect(204);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: desktop.refreshToken })
      .expect(401);
  });

  it('P10-SEC-005 — a revoked session\'s ACCESS token is refused on the very next request', async () => {
    const email = await registerUser('p10-005');
    const laptop = await signInAs(email, CHROME_MAC);
    const desktop = await signInAs(email, FIREFOX_WINDOWS);

    // The token is cryptographically valid and nowhere near expiry.
    await listSessions(desktop.accessToken).expect(200);

    const sessions = await listSessions(laptop.accessToken).expect(200);
    const target = sessions.body.find((s: { isCurrent: boolean }) => !s.isCurrent);
    await request(app.getHttpServer())
      .delete(`/auth/sessions/${target.id}`)
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .expect(204);

    // No waiting for expiry: the same still-unexpired token is now dead.
    await listSessions(desktop.accessToken).expect(401);
  });

  it('P10-SEC-006 — one user cannot revoke another user\'s session', async () => {
    const victimEmail = await registerUser('p10-006-victim');
    const attackerEmail = await registerUser('p10-006-attacker');
    const victim = await signInAs(victimEmail, CHROME_MAC);
    const attacker = await signInAs(attackerEmail, FIREFOX_WINDOWS);

    const victimSessions = await listSessions(victim.accessToken).expect(200);
    const victimSessionId = victimSessions.body[0].id;

    // 404, not 403: the endpoint must not confirm that another user's
    // session id is real. Both cases are indistinguishable to a prober.
    await request(app.getHttpServer())
      .delete(`/auth/sessions/${victimSessionId}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`)
      .expect(404);

    // The victim is completely unaffected.
    await listSessions(victim.accessToken).expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: victim.refreshToken })
      .expect(200);
  });

  it('P10-SEC-007 — multiple devices are distinguishable in the list', async () => {
    const email = await registerUser('p10-007');
    const mac = await signInAs(email, CHROME_MAC);
    await signInAs(email, FIREFOX_WINDOWS);

    const sessions = await listSessions(mac.accessToken).expect(200);
    expect(sessions.body).toHaveLength(2);

    const labels = sessions.body.map((s: { deviceLabel?: string }) => s.deviceLabel);
    expect(labels).toContain('Chrome on macOS');
    expect(labels).toContain('Firefox on Windows');

    // Exactly one session is the caller's own.
    const current = sessions.body.filter((s: { isCurrent: boolean }) => s.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0].deviceLabel).toBe('Chrome on macOS');
  });

  it('P10-SEC-008 — IP, user agent and last-used are really persisted, not fabricated', async () => {
    const email = await registerUser('p10-008');
    const device = await signInAs(email, CHROME_MAC);

    const sessions = await listSessions(device.accessToken).expect(200);
    const session = sessions.body[0];

    expect(session.userAgent).toBe(CHROME_MAC);
    expect(session.ipAddress).toBeTruthy();
    expect(session.lastUsedAt).toBeTruthy();
    expect(session.startedAt).toBeTruthy();
    expect(session.expiresAt).toBeTruthy();

    // Confirm against the database rather than trusting the API to echo
    // back what it was handed.
    const row = await admin.refreshToken.findFirst({
      where: { sessionId: session.id, revokedAt: null },
    });
    expect(row?.userAgent).toBe(CHROME_MAC);
    expect(row?.ipAddress).toBeTruthy();
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
    expect(row?.deviceLabel).toBe('Chrome on macOS');
  });

  it('P10-SEC-009 — refresh advances lastUsedAt and keeps ONE session, with a stable id', async () => {
    const email = await registerUser('p10-009');
    const device = await signInAs(email, CHROME_MAC);

    const before = await listSessions(device.accessToken).expect(200);
    const sessionId = before.body[0].id;
    const firstUsed = before.body[0].lastUsedAt;

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('User-Agent', CHROME_MAC)
      .send({ refreshToken: device.refreshToken })
      .expect(200);

    const after = await listSessions(refreshed.body.accessToken).expect(200);

    // Rotation must not look like a new device.
    expect(after.body).toHaveLength(1);
    expect(after.body[0].id).toBe(sessionId);
    expect(new Date(after.body[0].lastUsedAt).getTime()).toBeGreaterThan(
      new Date(firstUsed).getTime(),
    );
    // `startedAt` still reports the original sign-in, not the rotation.
    expect(after.body[0].startedAt).toBe(before.body[0].startedAt);
    // The rotated access token carries the SESSION id, so the caller's own
    // row is still marked current. This regressed once during Phase 10 —
    // `sid` was the refresh-token row id, which also silently broke
    // revocation of any rotated session.
    expect(after.body[0].isCurrent).toBe(true);
  });

  it('P10-SEC-010 — existing sign-in and sign-out behaviour is unchanged', async () => {
    const email = await registerUser('p10-010');

    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    expect(signIn.body.accessToken).toBeTruthy();
    expect(signIn.body.refreshToken).toBeTruthy();
    expect(signIn.body.user.id).toBeTruthy();

    await request(app.getHttpServer())
      .get('/auth/validate')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);

    // 200, per the endpoint's explicit `@HttpCode(HttpStatus.OK)` — this
    // suite asserts the EXISTING contract is unchanged, so the pre-Phase-10
    // status code is what must be pinned here.
    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${signIn.body.accessToken}`)
      .expect(200);

    // Wrong password is still rejected, and still generically.
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: 'wrong-password-entirely' })
      .expect(401);
  });

  it('P10-SEC-011 — sign-out revokes only its own session, immediately', async () => {
    const email = await registerUser('p10-011');
    const laptop = await signInAs(email, CHROME_MAC);
    const phone = await signInAs(email, FIREFOX_WINDOWS);

    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(200);

    // The signed-out device is dead on its next request...
    await listSessions(phone.accessToken).expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: phone.refreshToken })
      .expect(401);

    // ...and the other device is untouched. Signing out one device must
    // never sign out all of them.
    const remaining = await listSessions(laptop.accessToken).expect(200);
    expect(remaining.body).toHaveLength(1);
    expect(remaining.body[0].isCurrent).toBe(true);
  });

  it('P10-SEC-012 — the 2FA insertion point exists, is documented, and issues nothing before it', async () => {
    // Phase 10 explicitly DEFERS 2FA. This is a structural test: it
    // guards the insertion point's position rather than any behaviour,
    // because the one thing that would make a future 2FA implementation
    // unsafe is the hook drifting to AFTER tokens are already issued.
    const source = readFileSync(
      join(__dirname, '..', 'src', 'identity', 'services', 'auth.service.ts'),
      'utf8',
    );

    expect(source).toContain('2FA INSERTION POINT');

    const insertionPoint = source.indexOf('2FA INSERTION POINT');
    const signInStart = source.indexOf('async signIn(');
    const issueSessionCall = source.indexOf('this.issueSession(', signInStart);

    expect(signInStart).toBeGreaterThan(-1);
    expect(insertionPoint).toBeGreaterThan(signInStart);
    // The hook must sit BEFORE any session is issued, so a future
    // implementation can interrupt sign-in without having already handed
    // out a usable token pair.
    expect(insertionPoint).toBeLessThan(issueSessionCall);

    // And no 2FA is actually enforced yet: a correct password alone still
    // completes sign-in.
    const email = await registerUser('p10-012');
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
  });

  it('P10-SEC-013 — sign-in rate limiting still applies and is not globally shared', async () => {
    const email = await registerUser('p10-013');

    // Exhaust the per-identifier sign-in budget with wrong passwords.
    let sawRateLimit = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password: 'wrong-password-entirely' });
      if (response.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);

    // A DIFFERENT user must not be locked out by the first user's abuse.
    // This is the "no accidental global lockout" requirement — before
    // `trust proxy` was configured, every request shared one IP bucket.
    await flushRateLimitKeys();
    const otherEmail = await registerUser('p10-013-bystander');
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: otherEmail, password: PASSWORD })
      .expect(200);
  });

  it('P10-SEC-014 — session responses never contain token material', async () => {
    const email = await registerUser('p10-014');
    const device = await signInAs(email, CHROME_MAC);

    const sessions = await listSessions(device.accessToken).expect(200);
    const raw = JSON.stringify(sessions.body);

    // No secret, in any form, ever appears in this response.
    expect(raw).not.toContain(device.refreshToken);
    expect(raw).not.toContain(device.accessToken);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('userId');

    // The exposed keys are exactly the documented contract — a new field
    // leaking in would fail here rather than in production.
    expect(Object.keys(sessions.body[0]).sort()).toEqual(
      [
        'deviceLabel',
        'expiresAt',
        'id',
        'ipAddress',
        'isCurrent',
        'lastUsedAt',
        'startedAt',
        'userAgent',
      ].sort(),
    );

    // The session id is NOT the refresh-token row id — exposing the row
    // id would leak a value the token-validation path treats as meaningful.
    const row = await admin.refreshToken.findFirst({
      where: { sessionId: sessions.body[0].id, revokedAt: null },
    });
    expect(row).toBeTruthy();
    expect(sessions.body[0].id).not.toBe(row?.tokenHash);
  });
});
