/**
 * Production-readiness pass — the refresh token lives only in the HttpOnly
 * session cookie. Real PostgreSQL and Redis.
 *
 *   SC-01  sign-in returns NO refresh token in the body; it sets
 *          `atlas_session` HttpOnly, SameSite=Strict, Path=/
 *   SC-02  refresh by cookie (same origin) rotates: 200, a new cookie, no
 *          refresh token in the body; the new cookie works, the old one fails
 *   SC-03  the cookie is refused from a foreign origin, from a sibling
 *          subdomain, and with no Origin at all — and nothing rotates
 *   SC-04  sign-out by cookie alone (no access token) ends the session family
 *          and clears the cookie
 *   SC-05  a failed cookie refresh clears the cookie
 *   SC-06  a pre-cookie body token is converted once: body refresh → cookie,
 *          never a token in the body
 *   SC-07  stale-tab recovery — a refresh that lost a race to a concurrent
 *          one (two tabs, within the reuse grace) is refused WITHOUT
 *          clearing the cookie, so the winner's newer cookie survives; the
 *          same token replayed after the grace still clears it and ends
 *          the session family
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';
import { sessionCookieHeader, sessionTokenFrom } from './utils/session-cookie';

jest.setTimeout(120000);
const PASSWORD = 'correct-horse-battery-cookie';

describe('Session cookie (e2e)', () => {
  let app: INestApplication;
  let flush: () => Promise<void>;
  let origin: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    // Already listening on 127.0.0.1 (createTestApp binds it once).
    const { port } = app.getHttpServer().address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(origin);

  async function signIn(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    return http().post('/auth/sign-in').send({ email, password: PASSWORD }).expect(200);
  }

  const cookieRefresh = (token: string, from: string | null = origin) => {
    const req = http().post('/auth/refresh').set('Cookie', sessionCookieHeader(token));
    return from ? req.set('Origin', from) : req;
  };

  const setCookies = (res: request.Response): string[] =>
    ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);

  it('SC-01 — sign-in: no refresh token in the body; an HttpOnly, SameSite=Strict session cookie', async () => {
    const res = await signIn('sc01');
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(res.body)).not.toContain(sessionTokenFrom(res) as string);
    const cookie = setCookies(res).find((c) => c.startsWith('atlas_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
  });

  it('SC-02 — refresh by cookie rotates it; the body carries only the access token', async () => {
    const first = sessionTokenFrom(await signIn('sc02')) as string;
    const rotated = await cookieRefresh(first).expect(200);
    expect(rotated.body.accessToken).toEqual(expect.any(String));
    expect(rotated.body).not.toHaveProperty('refreshToken');
    const second = sessionTokenFrom(rotated) as string;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    await cookieRefresh(second).expect(200);
    await cookieRefresh(first).expect(401);
  });

  it('SC-03 — refused from a foreign origin, a sibling subdomain, or with no Origin; nothing rotates', async () => {
    const token = sessionTokenFrom(await signIn('sc03')) as string;
    for (const from of ['https://evil.example', 'http://other-academy.127.0.0.1', null]) {
      const res = await cookieRefresh(token, from).expect(403);
      expect(res.body.error.messageKey).toBe('errors.auth.crossOriginSession');
      expect(sessionTokenFrom(res)).toBeUndefined();
    }
    // The session was never rotated: the original cookie still works.
    await cookieRefresh(token).expect(200);
  });

  it('SC-04 — sign-out by cookie alone ends the whole session family and clears the cookie', async () => {
    const res = await signIn('sc04');
    const token = sessionTokenFrom(res) as string;
    const rotated = sessionTokenFrom(await cookieRefresh(token).expect(200)) as string;
    const out = await http()
      .post('/auth/sign-out')
      .set('Origin', origin)
      .set('Cookie', sessionCookieHeader(rotated))
      .expect(200);
    expect(setCookies(out).some((c) => /^atlas_session=;/.test(c))).toBe(true);
    await cookieRefresh(rotated).expect(401);
    // The access token minted with the session is denied at once as well.
    await http()
      .get('/users/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(401);
    // And from a foreign origin, a cookie sign-out is refused (no CSRF logout).
    const other = sessionTokenFrom(await signIn('sc04b')) as string;
    await http()
      .post('/auth/sign-out')
      .set('Origin', 'https://evil.example')
      .set('Cookie', sessionCookieHeader(other))
      .expect(403);
    await cookieRefresh(other).expect(200);
  });

  it('SC-05 — a failed cookie refresh clears the cookie', async () => {
    const res = await cookieRefresh('not-a-real-session-token').expect(401);
    expect(setCookies(res).some((c) => /^atlas_session=;/.test(c))).toBe(true);
  });

  it('SC-06 — a pre-cookie body token converts into a cookie session, never back into a body', async () => {
    const legacy = sessionTokenFrom(await signIn('sc06')) as string;
    const converted = await http()
      .post('/auth/refresh')
      .send({ refreshToken: legacy })
      .expect(200);
    expect(converted.body).not.toHaveProperty('refreshToken');
    const cookie = sessionTokenFrom(converted) as string;
    expect(cookie).toBeTruthy();
    await cookieRefresh(cookie).expect(200);
    // With neither cookie nor body there is nothing to refresh.
    await http().post('/auth/refresh').set('Origin', origin).send({}).expect(401);
  });

  it('SC-07 — a refresh that lost a concurrent race keeps the newer cookie; a replay after the grace does not', async () => {
    const original = sessionTokenFrom(await signIn('sc07')) as string;
    // Tab A refreshes first and wins: the browser now holds `newer`.
    const winner = await cookieRefresh(original).expect(200);
    const newer = sessionTokenFrom(winner) as string;
    expect(newer).toBeTruthy();

    // Tab B's request carried the old cookie a moment earlier: refused with
    // the same generic 401 — but no Set-Cookie that would clear `newer`.
    const loser = await cookieRefresh(original).expect(401);
    expect(loser.body.error.messageKey).toBe('errors.auth.invalidRefreshToken');
    expect(setCookies(loser).some((c) => /^atlas_session=;/.test(c))).toBe(false);
    // The session is intact: the newer cookie still rotates.
    const next = sessionTokenFrom(await cookieRefresh(newer).expect(200)) as string;

    // Past the grace, the same old token is a replay: cookie cleared and
    // the whole family ended (the newest token stops working too).
    const admin = createAdminPrisma();
    try {
      await admin.refreshToken.update({
        where: { tokenHash: hashOpaqueToken(original) },
        data: { revokedAt: new Date(Date.now() - 5 * 60 * 1000) },
      });
    } finally {
      await admin.$disconnect();
    }
    const replay = await cookieRefresh(original).expect(401);
    expect(setCookies(replay).some((c) => /^atlas_session=;/.test(c))).toBe(true);
    await cookieRefresh(next).expect(401);
  });
});
