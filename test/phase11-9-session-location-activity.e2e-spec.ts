/**
 * Phase 11.9 / 11.10 — session location and real "Last active"
 * (P119-SES-001..014).
 *
 * TWO RULES THESE PIN, AND THEY PULL IN OPPOSITE DIRECTIONS:
 *
 *   1. Location must be REAL. It comes from Cloudflare's `CF-IPCountry`
 *      edge header — verified as actually arriving in production before
 *      being built on. A fabricated or IP-guessed city is explicitly out
 *      of scope, so when no trustworthy country exists the field is
 *      ABSENT and the UI says so.
 *   2. "Last active" must be FRESH without writing to Postgres on every
 *      request. Activity goes to Redis every time and is flushed to the
 *      database on a per-session lease, so these assert the value the API
 *      returns rather than the column directly.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('Phase 11.9 session location & activity (e2e) — P119-SES-001..014', () => {
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

  /** Signs up and signs in, optionally presenting Cloudflare edge headers. */
  async function signIn(label: string, headers: Record<string, string> = {}) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);

    const signInRequest = request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh) Chrome/120.0')
      .send({ email, password: PASSWORD });
    for (const [name, value] of Object.entries(headers)) {
      signInRequest.set(name, value);
    }
    const response = await signInRequest.expect(200);

    return {
      email,
      userId: response.body.user.id as string,
      token: response.body.accessToken as string,
      refreshToken: response.body.refreshToken as string,
    };
  }

  const listSessions = (token: string) =>
    request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${token}`);

  // ---------------- location ----------------

  it('P119-SES-001 — a Cloudflare country is recorded and returned', async () => {
    const account = await signIn('p119-001', { 'CF-IPCountry': 'EG' });

    const sessions = await listSessions(account.token).expect(200);

    expect(sessions.body).toHaveLength(1);
    expect(sessions.body[0].locationCountry).toBe('EG');
  });

  it('P119-SES-002 — no Cloudflare header means NO location, not a guess', async () => {
    // The headline honesty rule. Without an edge country there is nothing
    // trustworthy to show, and the field must be absent so the UI can say
    // "Location unavailable" rather than invent a place.
    const account = await signIn('p119-002');

    const sessions = await listSessions(account.token).expect(200);

    expect(sessions.body[0].locationCountry).toBeUndefined();
  });

  it("P119-SES-003 — Cloudflare's XX (unknown) sentinel is not stored as a country", async () => {
    const account = await signIn('p119-003', { 'CF-IPCountry': 'XX' });

    const sessions = await listSessions(account.token).expect(200);
    expect(sessions.body[0].locationCountry).toBeUndefined();
  });

  it('P119-SES-004 — the Tor sentinel T1 is not stored as a country', async () => {
    const account = await signIn('p119-004', { 'CF-IPCountry': 'T1' });

    const sessions = await listSessions(account.token).expect(200);
    expect(sessions.body[0].locationCountry).toBeUndefined();
  });

  it('P119-SES-005 — a malformed country header is discarded', async () => {
    // Bounded and shape-checked so a hostile or broken header can never
    // put arbitrary text into a field the UI renders.
    for (const value of ['EGYPT', '1', 'e', '<script>']) {
      const account = await signIn(`p119-005-${value.replace(/\W/g, '')}`, {
        'CF-IPCountry': value,
      });
      const sessions = await listSessions(account.token).expect(200);
      expect(sessions.body[0].locationCountry).toBeUndefined();
    }
  });

  it('P119-SES-006 — the country is stored uppercased and only two characters', async () => {
    const account = await signIn('p119-006', { 'CF-IPCountry': 'sa' });

    const stored = await admin.refreshToken.findFirst({
      where: { userId: account.userId, revokedAt: null },
    });
    expect(stored?.locationCountry).toBe('SA');
  });

  it('P119-SES-007 — no coordinates, city or ASN are ever returned', async () => {
    // Privacy: the minimum useful location, and nothing more.
    const account = await signIn('p119-007', { 'CF-IPCountry': 'EG' });

    const sessions = await listSessions(account.token).expect(200);
    const keys = Object.keys(sessions.body[0]);
    for (const forbidden of [
      'city',
      'region',
      'latitude',
      'longitude',
      'asn',
      'postalCode',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('P119-SES-008 — a refresh without an edge country keeps the known one', async () => {
    // A refresh from a context with no Cloudflare header must not erase a
    // country the session already legitimately had.
    const account = await signIn('p119-008', { 'CF-IPCountry': 'EG' });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: account.refreshToken })
      .expect(200);

    const sessions = await listSessions(account.token).expect(200);
    expect(sessions.body[0].locationCountry).toBe('EG');
  });

  // ---------------- last active ----------------

  it('P119-SES-009 — a new session reports a last-active time', async () => {
    const account = await signIn('p119-009');

    const sessions = await listSessions(account.token).expect(200);
    expect(sessions.body[0].lastUsedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(sessions.body[0].lastUsedAt))).toBe(false);
  });

  it('P119-SES-010 — ordinary authenticated activity moves last-active forward', async () => {
    // The actual defect: `lastUsedAt` only moved on token refresh, so a
    // user working continuously looked idle. Any authenticated request
    // should now count.
    const account = await signIn('p119-010');
    const first = await listSessions(account.token).expect(200);
    const before = Date.parse(first.body[0].lastUsedAt);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(200);
    // Activity is recorded fire-and-forget, so allow it to land.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const second = await listSessions(account.token).expect(200);
    expect(Date.parse(second.body[0].lastUsedAt)).toBeGreaterThan(before);
  });

  it('P119-SES-011 — activity is NOT written to Postgres on every request', async () => {
    // The other half of the requirement: freshness must not cost a write
    // per request. The column is flushed on a per-session lease, so a
    // burst of requests must leave it unchanged.
    const account = await signIn('p119-011');

    const burst = async () => {
      for (let i = 0; i < 8; i += 1) {
        await request(app.getHttpServer())
          .get('/users/me')
          .set('Authorization', `Bearer ${account.token}`)
          .expect(200);
      }
      // Activity is recorded fire-and-forget; let it land.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const row = await admin.refreshToken.findFirstOrThrow({
        where: { userId: account.userId, revokedAt: null },
      });
      return row.lastUsedAt?.getTime();
    };

    // Sign-in does not pass through `JwtAuthGuard`, so the FIRST
    // authenticated request legitimately takes the lease and writes once.
    // That is the design: at most one write per session per interval, not
    // zero. What must not happen is a write per request.
    const afterFirstBurst = await burst();
    const afterSecondBurst = await burst();

    // Sixteen requests, and the second eight produced no write at all
    // because the lease from the first is still held.
    expect(afterSecondBurst).toBe(afterFirstBurst);
  });

  // ---------------- isolation & revocation ----------------

  it('P119-SES-012 — two devices appear as two separate sessions', async () => {
    const account = await signIn('p119-012', { 'CF-IPCountry': 'EG' });
    const second = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('User-Agent', 'Mozilla/5.0 (iPhone) Safari/17.0')
      .set('CF-IPCountry', 'SA')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);

    const sessions = await listSessions(second.body.accessToken).expect(200);
    expect(sessions.body).toHaveLength(2);
    // Each carries its OWN country, not the most recent one for the user.
    expect(
      sessions.body.map((s: { locationCountry?: string }) => s.locationCountry).sort(),
    ).toEqual(['EG', 'SA']);
    // Exactly one is flagged as the caller's own session.
    expect(sessions.body.filter((s: { isCurrent: boolean }) => s.isCurrent)).toHaveLength(
      1,
    );
  });

  it('P119-SES-013 — revoking one session leaves the other working', async () => {
    const account = await signIn('p119-013');
    const second = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);

    const sessions = await listSessions(second.body.accessToken).expect(200);
    const other = sessions.body.find((s: { isCurrent: boolean }) => !s.isCurrent);

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(204);

    // The revoked one is dead immediately...
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(401);
    // ...and the surviving one is unaffected.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(200);
  });

  it("P119-SES-014 — a user never sees another user's sessions", async () => {
    const mine = await signIn('p119-014-mine', { 'CF-IPCountry': 'EG' });
    const theirs = await signIn('p119-014-theirs', { 'CF-IPCountry': 'SA' });

    const sessions = await listSessions(mine.token).expect(200);

    expect(sessions.body).toHaveLength(1);
    expect(sessions.body[0].locationCountry).toBe('EG');

    // And revoking by a session id that is not mine does nothing.
    const theirSessions = await listSessions(theirs.token).expect(200);
    const response = await request(app.getHttpServer())
      .delete(`/auth/sessions/${theirSessions.body[0].id}`)
      .set('Authorization', `Bearer ${mine.token}`);
    expect([204, 403, 404]).toContain(response.status);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${theirs.token}`)
      .expect(200);
  });
});
