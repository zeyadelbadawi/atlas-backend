/**
 * U-14d / OD-21 — a refresh whose RESPONSE never reached the browser must not
 * sign the person out, and must not open a hole in replay detection.
 * Real PostgreSQL and Redis, cookie transport exactly as a browser uses it.
 *
 *   LR-01  a normal cookie refresh rotates (control)
 *   LR-02  the response is lost; the same browser presents the old cookie
 *          again inside the re-issue window → 200 with the SAME successor
 *          the lost response carried; nothing new is minted, the family is
 *          not revoked, no reuse is recorded, and the successor keeps
 *          rotating normally
 *   LR-03  the old cookie after its successor was already used → never
 *          re-issued; refused; once past the grace the whole family ends
 *   LR-04  the old cookie from a DIFFERENT client inside the window
 *          (another User-Agent, another device cookie, or the token moved
 *          into a request body) → the whole family ends at once
 *   LR-05  the old cookie after the window → never re-issued; refused; once
 *          past the grace the whole family ends
 *   LR-06  N concurrent refreshes with one cookie → every one is answered
 *          with the one successor; exactly one chain exists afterwards
 *   LR-07  a session ended by sign-out, a password change or a suspended
 *          account is never revived by a retry inside the window
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';
import { sessionCookieHeader, sessionTokenFrom } from './utils/session-cookie';

jest.setTimeout(180000);
const PASSWORD = 'correct-horse-battery-lost';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AtlasLostResponseFixture/1.0';
const OTHER_UA = 'curl/8.0.0 (replay fixture)';

describe('Refresh after a lost response (e2e) — U-14d / OD-21', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let origin: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    const { port } = app.getHttpServer().address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
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
    const res = await http()
      .post('/auth/sign-in')
      .set('User-Agent', BROWSER_UA)
      .send({ email, password: PASSWORD })
      .expect(200);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return {
      email,
      userId: user.id,
      accessToken: res.body.accessToken as string,
      token: sessionTokenFrom(res) as string,
    };
  }

  /** A browser refresh: the session cookie, this page's Origin, the browser's UA. */
  const cookieRefresh = (
    token: string,
    opts: { ua?: string; extraCookie?: string } = {},
  ) =>
    http()
      .post('/auth/refresh')
      .set('Origin', origin)
      .set('User-Agent', opts.ua ?? BROWSER_UA)
      .set(
        'Cookie',
        [sessionCookieHeader(token), opts.extraCookie].filter(Boolean).join('; '),
      );

  const setCookies = (res: request.Response): string[] =>
    ([] as string[]).concat((res.headers['set-cookie'] as unknown as string[]) ?? []);
  const clearsCookie = (res: request.Response) =>
    setCookies(res).some((c) => /^atlas_session=;/.test(c));

  const liveRows = (userId: string) =>
    admin.refreshToken.count({ where: { userId, revokedAt: null } });
  const reuseAudits = (userId: string) =>
    admin.auditLogEntry.count({
      where: {
        actorUserId: userId,
        action: 'auth.sessions.revoked',
        context: { path: ['trigger'], equals: 'refresh_token_reuse' },
      },
    });
  const backdateRotation = (token: string, msAgo: number) =>
    admin.refreshToken.update({
      where: { tokenHash: hashOpaqueToken(token) },
      data: { revokedAt: new Date(Date.now() - msAgo) },
    });
  const validates = (accessToken: string) =>
    http().get('/auth/validate').set('Authorization', `Bearer ${accessToken}`);

  it('LR-01 — a normal cookie refresh rotates (control)', async () => {
    const s = await signIn('lr01');
    const rotated = await cookieRefresh(s.token).expect(200);
    const next = sessionTokenFrom(rotated) as string;
    expect(next).toBeTruthy();
    expect(next).not.toBe(s.token);
    await validates(rotated.body.accessToken).expect(200);
    expect(await admin.refreshToken.count({ where: { userId: s.userId } })).toBe(2);
    expect(await liveRows(s.userId)).toBe(1);
  });

  it('LR-02 — lost response, retried by the same browser inside the window: the same successor, no revocation', async () => {
    const s = await signIn('lr02');
    // The server rotates; the browser never sees this response.
    const lost = await cookieRefresh(s.token).expect(200);
    const successor = sessionTokenFrom(lost) as string;

    // The browser still holds the old cookie and retries.
    const retry = await cookieRefresh(s.token).expect(200);
    expect(clearsCookie(retry)).toBe(false);
    expect(sessionTokenFrom(retry)).toBe(successor);
    expect(retry.body).not.toHaveProperty('refreshToken');
    await validates(retry.body.accessToken).expect(200);

    // Nothing new was minted and nothing was revoked: one chain, one live row.
    expect(await admin.refreshToken.count({ where: { userId: s.userId } })).toBe(2);
    expect(await liveRows(s.userId)).toBe(1);
    expect(await reuseAudits(s.userId)).toBe(0);
    // The access token of the original sign-in still works (no denylist entry).
    await validates(s.accessToken).expect(200);

    // The re-issued successor rotates normally afterwards.
    const after = await cookieRefresh(successor).expect(200);
    expect(sessionTokenFrom(after)).not.toBe(successor);
    expect(await liveRows(s.userId)).toBe(1);
  });

  it('LR-03 — the old cookie after its successor was used is never re-issued; past the grace the family ends', async () => {
    const s = await signIn('lr03');
    const successor = sessionTokenFrom(
      await cookieRefresh(s.token).expect(200),
    ) as string;
    const third = sessionTokenFrom(await cookieRefresh(successor).expect(200)) as string;

    // Inside the window, but the successor has already been used: refused,
    // and nothing is handed out.
    const stale = await cookieRefresh(s.token).expect(401);
    expect(sessionTokenFrom(stale)).toBeUndefined();
    expect(await admin.refreshToken.count({ where: { userId: s.userId } })).toBe(3);

    // Past the grace the same presentation is a replay: the family ends.
    await backdateRotation(s.token, 5 * 60 * 1000);
    const replay = await cookieRefresh(s.token).expect(401);
    expect(clearsCookie(replay)).toBe(true);
    await cookieRefresh(third).expect(401);
    expect(await liveRows(s.userId)).toBe(0);
    expect(await reuseAudits(s.userId)).toBe(1);
  });

  it('LR-04 — the old cookie from a different client inside the window ends the family at once', async () => {
    // Another User-Agent.
    const a = await signIn('lr04a');
    const aNext = sessionTokenFrom(await cookieRefresh(a.token).expect(200)) as string;
    const foreign = await cookieRefresh(a.token, { ua: OTHER_UA }).expect(401);
    expect(sessionTokenFrom(foreign)).toBeUndefined();
    expect(clearsCookie(foreign)).toBe(true);
    await cookieRefresh(aNext).expect(401);
    expect(await liveRows(a.userId)).toBe(0);
    expect(await reuseAudits(a.userId)).toBe(1);

    // Same User-Agent, but another device cookie than the rotating request carried.
    const b = await signIn('lr04b');
    const device = 'atlas_device=fixture-device-one';
    const bNext = sessionTokenFrom(
      await cookieRefresh(b.token, { extraCookie: device }).expect(200),
    ) as string;
    await cookieRefresh(b.token, {
      extraCookie: 'atlas_device=fixture-device-two',
    }).expect(401);
    await cookieRefresh(bNext, { extraCookie: device }).expect(401);
    expect(await liveRows(b.userId)).toBe(0);

    // The cookie token lifted into a request body (no cookie, no Origin).
    const c = await signIn('lr04c');
    const cNext = sessionTokenFrom(await cookieRefresh(c.token).expect(200)) as string;
    await http()
      .post('/auth/refresh')
      .set('User-Agent', BROWSER_UA)
      .send({ refreshToken: c.token })
      .expect(401);
    await cookieRefresh(cNext).expect(401);
    expect(await liveRows(c.userId)).toBe(0);
  });

  it('LR-05 — after the window the old cookie is never re-issued; past the grace the family ends', async () => {
    const s = await signIn('lr05');
    const successor = sessionTokenFrom(
      await cookieRefresh(s.token).expect(200),
    ) as string;

    // 45 s after the rotation: outside the 30 s re-issue window, inside the
    // pre-existing 60 s stale-tab grace — refused, nothing handed out, the
    // browser's (newer) cookie left alone.
    await backdateRotation(s.token, 45 * 1000);
    const late = await cookieRefresh(s.token).expect(401);
    expect(sessionTokenFrom(late)).toBeUndefined();
    expect(clearsCookie(late)).toBe(false);
    expect(await liveRows(s.userId)).toBe(1);

    // Past the grace: a replay, the family ends.
    await backdateRotation(s.token, 5 * 60 * 1000);
    await cookieRefresh(s.token).expect(401);
    await cookieRefresh(successor).expect(401);
    expect(await liveRows(s.userId)).toBe(0);
    expect(await reuseAudits(s.userId)).toBe(1);
  });

  it('LR-06 — N concurrent refreshes with one cookie: one successor for all, exactly one chain', async () => {
    const s = await signIn('lr06');
    const N = 6;
    const responses = await Promise.all(
      Array.from({ length: N }, () => cookieRefresh(s.token)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));
    const issued = new Set(responses.map((r) => sessionTokenFrom(r)));
    expect(issued.size).toBe(1);
    const [successor] = [...issued] as string[];

    const rows = await admin.refreshToken.findMany({ where: { userId: s.userId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.revokedAt === null)?.tokenHash).toBe(
      hashOpaqueToken(successor),
    );
    expect(await reuseAudits(s.userId)).toBe(0);
    await cookieRefresh(successor).expect(200);
  });

  it('LR-07 — sign-out, a password change or a suspended account is never undone by a retry', async () => {
    // Sign-out of the successor (the browser that did receive it).
    const a = await signIn('lr07a');
    const aNext = sessionTokenFrom(await cookieRefresh(a.token).expect(200)) as string;
    await http()
      .post('/auth/sign-out')
      .set('Origin', origin)
      .set('Cookie', sessionCookieHeader(aNext))
      .expect(200);
    const afterSignOut = await cookieRefresh(a.token).expect(401);
    expect(sessionTokenFrom(afterSignOut)).toBeUndefined();
    await cookieRefresh(aNext).expect(401);
    expect(await liveRows(a.userId)).toBe(0);

    // A password change from another session revokes every session.
    const b = await signIn('lr07b');
    const bLost = await cookieRefresh(b.token).expect(200);
    const other = await http()
      .post('/auth/sign-in')
      .set('User-Agent', BROWSER_UA)
      .send({ email: b.email, password: PASSWORD })
      .expect(200);
    await http()
      .post('/users/me/password')
      .set('Authorization', `Bearer ${other.body.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: `${PASSWORD}-changed` })
      .expect(200);
    const afterChange = await cookieRefresh(b.token).expect(401);
    expect(sessionTokenFrom(afterChange)).toBeUndefined();
    await cookieRefresh(sessionTokenFrom(bLost) as string).expect(401);
    expect(await liveRows(b.userId)).toBe(0);

    // A suspended account: the retry ends the session instead of renewing it.
    const c = await signIn('lr07c');
    const cNext = sessionTokenFrom(await cookieRefresh(c.token).expect(200)) as string;
    await admin.user.update({ where: { id: c.userId }, data: { status: 'suspended' } });
    const afterSuspend = await cookieRefresh(c.token).expect(401);
    expect(sessionTokenFrom(afterSuspend)).toBeUndefined();
    expect(await liveRows(c.userId)).toBe(0);
    await admin.user.update({ where: { id: c.userId }, data: { status: 'active' } });
    await cookieRefresh(cNext).expect(401);
  });
});
