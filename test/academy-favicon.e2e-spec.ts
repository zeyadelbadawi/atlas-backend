/**
 * The Academy favicon reaches the public website (2 Oct 2026).
 *
 * An Owner's uploaded favicon was saved (a data URL in
 * `academies.favicon_url`) and then never used: the public site's head
 * kept the platform's `/favicon.svg`, nothing served the stored bytes,
 * and the field accepted any string. Pinned here against the real
 * database and cache:
 *   - the hostname resolution carries a `faviconVersion` exactly when the
 *     Academy has a servable favicon, and it changes when the favicon does
 *     — on the very next resolution (the 60 s cache is dropped on save);
 *   - `GET public/websites/:academyId/favicon` serves that Academy's exact
 *     bytes and type, immutable for the current version only;
 *   - two Academies each get their own favicon; none means 404 and no
 *     version (the platform default stays);
 *   - only PNG/ICO data URLs, own media paths or http(s) URLs are accepted,
 *     and only Atlas-hosted favicons are ever served (W2: no open redirect).
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

/** A real 1×1 PNG, and a second one differing in its pixel. */
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==',
  'base64',
);
const dataUrl = (type: string, bytes: Buffer) =>
  `data:${type};base64,${bytes.toString('base64')}`;

describe('Academy favicon on the public website (e2e)', () => {
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

  async function seedAcademyWithHost(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const userId = signIn.body.user.id as string;
    const org = await seedOrganizationWithOwner(admin, userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.favicon.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { token: signIn.body.accessToken as string, academyId: academy.id, host };
  }

  const setFavicon = (token: string, academyId: string, favicon: string) =>
    request(app.getHttpServer())
      .patch(`/academies/${academyId}/branding`)
      .set('Authorization', `Bearer ${token}`)
      .send({ favicon });

  const resolve = (host: string) =>
    request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: host })
      .expect(200)
      .then((r) => r.body as { academyId: string; faviconVersion?: string });

  const favicon = (academyId: string, version?: string) =>
    request(app.getHttpServer())
      .get(`/public/websites/${academyId}/favicon`)
      .query(version ? { v: version } : {})
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  it('an uploaded favicon is what the public site links and serves, and a new one replaces it at once', async () => {
    const a = await seedAcademyWithHost('fav-a');

    // No favicon yet: no version, nothing served — the default stays.
    expect((await resolve(a.host)).faviconVersion).toBeUndefined();
    await favicon(a.academyId).expect(404);

    await setFavicon(a.token, a.academyId, dataUrl('image/png', PNG_A)).expect(200);
    // The resolution was cached by the read above; saving drops it.
    const first = (await resolve(a.host)).faviconVersion;
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    const served = await favicon(a.academyId, first).expect(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(served.body as Buffer, PNG_A)).toBe(0);

    // Replaced: a new version at once, the new bytes, and the old URL is
    // no longer cached for long.
    await setFavicon(a.token, a.academyId, dataUrl('image/png', PNG_B)).expect(200);
    const second = (await resolve(a.host)).faviconVersion;
    expect(second).toMatch(/^[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    const replaced = await favicon(a.academyId, second).expect(200);
    expect(Buffer.compare(replaced.body as Buffer, PNG_B)).toBe(0);
    const stale = await favicon(a.academyId, first).expect(200);
    expect(stale.headers['cache-control']).toBe('public, max-age=60');
    expect(Buffer.compare(stale.body as Buffer, PNG_B)).toBe(0);

    // An .ico keeps its own type.
    await setFavicon(a.token, a.academyId, dataUrl('image/x-icon', PNG_A)).expect(200);
    const ico = await favicon(a.academyId, (await resolve(a.host)).faviconVersion).expect(
      200,
    );
    expect(ico.headers['content-type']).toBe('image/x-icon');

    // Cleared: back to the platform default.
    await setFavicon(a.token, a.academyId, '').expect(200);
    expect((await resolve(a.host)).faviconVersion).toBeUndefined();
    await favicon(a.academyId).expect(404);
  });

  it('each Academy serves only its own favicon', async () => {
    const a = await seedAcademyWithHost('fav-iso-a');
    const b = await seedAcademyWithHost('fav-iso-b');
    await setFavicon(a.token, a.academyId, dataUrl('image/png', PNG_A)).expect(200);
    await setFavicon(b.token, b.academyId, dataUrl('image/png', PNG_B)).expect(200);

    const [resolvedA, resolvedB] = await Promise.all([resolve(a.host), resolve(b.host)]);
    expect(resolvedA.academyId).toBe(a.academyId);
    expect(resolvedB.academyId).toBe(b.academyId);
    expect(resolvedA.faviconVersion).not.toBe(resolvedB.faviconVersion);

    const servedA = await favicon(a.academyId, resolvedA.faviconVersion).expect(200);
    const servedB = await favicon(b.academyId, resolvedB.faviconVersion).expect(200);
    expect(Buffer.compare(servedA.body as Buffer, PNG_A)).toBe(0);
    expect(Buffer.compare(servedB.body as Buffer, PNG_B)).toBe(0);

    // B's Owner cannot set A's favicon.
    await setFavicon(b.token, a.academyId, dataUrl('image/png', PNG_B)).expect((res) =>
      expect([403, 404]).toContain(res.status),
    );
    const stillA = await favicon(a.academyId).expect(200);
    expect(Buffer.compare(stillA.body as Buffer, PNG_A)).toBe(0);
  });

  it('accepts only PNG/ICO images or http(s) URLs as a favicon', async () => {
    const a = await seedAcademyWithHost('fav-valid');
    for (const bad of [
      'javascript:alert(1)',
      'not a url',
      dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      dataUrl('text/html', Buffer.from('<script>alert(1)</script>')),
    ]) {
      await setFavicon(a.token, a.academyId, bad).expect(400);
    }
    // W2 — an external URL is still accepted on save (an existing value
    // must not make the branding form unsavable), but it is NEVER
    // redirected to: that was an open redirect on the Academy's own host,
    // cached immutable for a year. The platform icon stays instead.
    await setFavicon(a.token, a.academyId, 'https://cdn.example.com/icon.png').expect(
      200,
    );
    const remote = await request(app.getHttpServer())
      .get(`/public/websites/${a.academyId}/favicon`)
      .redirects(0)
      .expect(404);
    expect(remote.headers.location).toBeUndefined();
    expect((await resolve(a.host)).faviconVersion).toBeUndefined();
  });

  it('W2: redirects only to the Academy’s own uploaded image, same-origin and never immutable', async () => {
    const a = await seedAcademyWithHost('fav-media-a');
    const b = await seedAcademyWithHost('fav-media-b');
    const ownPath = `/api/v1/public/media/academies/${a.academyId}/${randomUUID()}.png`;

    await setFavicon(a.token, a.academyId, ownPath).expect(200);
    const version = (await resolve(a.host)).faviconVersion;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    const own = await request(app.getHttpServer())
      .get(`/public/websites/${a.academyId}/favicon`)
      .query({ v: version })
      .redirects(0)
      .expect(302);
    // Path only: the redirect cannot leave the host it was requested on.
    expect(own.headers.location).toBe(ownPath);
    expect(own.headers['cache-control']).toBe('public, max-age=300');

    // An absolute URL naming an Atlas media path is reduced to the path.
    await setFavicon(a.token, a.academyId, `https://evil.example${ownPath}`).expect(200);
    const absolute = await request(app.getHttpServer())
      .get(`/public/websites/${a.academyId}/favicon`)
      .redirects(0)
      .expect(302);
    expect(absolute.headers.location).toBe(ownPath);

    // Another Academy's media is not this Academy's favicon.
    const otherPath = `/api/v1/public/media/academies/${b.academyId}/${randomUUID()}.png`;
    await setFavicon(a.token, a.academyId, otherPath).expect(200);
    await request(app.getHttpServer())
      .get(`/public/websites/${a.academyId}/favicon`)
      .redirects(0)
      .expect(404);
    expect((await resolve(a.host)).faviconVersion).toBeUndefined();
  });
});
