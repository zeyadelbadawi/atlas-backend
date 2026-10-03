/**
 * One "Save Visual Identity" (Task G), against the real database, RLS and
 * the Redis caches.
 *
 * Reported: a new logo went live at once while its colours waited in the
 * draft for a site publish (visitors saw the new logo on the old colours),
 * and colour changes took a cache expiry — or "clearing cookies" — to show.
 * Pinned here:
 *   - name, logo, favicon and colours save in ONE transaction: an invalid
 *     palette saves nothing, a stale copy saves nothing;
 *   - on a published site the saved colours are public on the very next
 *     read — configuration AND the cached hostname resolution that carries
 *     them for the first paint — and `configVersion` moves on;
 *   - before the first publish, the Coming Soon page's colours follow the
 *     saved ones at once too;
 *   - `logo: null` removes the logo;
 *   - another Academy's owner, an instructor and an anonymous caller are
 *     refused, and another Academy's site is untouched.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';

const ORANGE = { primary: '24 95% 53%', secondary: '199 89% 38%', accent: '43 96% 56%' };
const GREEN = { primary: '142 71% 30%', secondary: '221 83% 40%', accent: '43 96% 56%' };
const palette = (seeds: typeof ORANGE) => ({
  seeds,
  status: 'confirmed',
  source: 'manual',
});

describe('Visual identity (e2e)', () => {
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

  async function signUpAndSignIn(label: string) {
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
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedAcademyWithHost(label: string) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.identity.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { owner, org, academy, host };
  }

  const save = (token: string | null, academyId: string, body: object) => {
    const req = request(app.getHttpServer()).put(
      `/academies/${academyId}/visual-identity`,
    );
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  };

  const getConfig = (token: string, academyId: string) =>
    request(app.getHttpServer())
      .get(`/academies/${academyId}/website/configuration`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .then((r) => r.body);

  const publish = (token: string, academyId: string) =>
    request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

  const resolve = (host: string) =>
    request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: host })
      .expect(200)
      .then(
        (r) =>
          r.body as {
            academyName: string;
            academyLogo?: string;
            presentation?: { brand: { primaryColor?: string } };
          },
      );

  const publicPrimary = (academyId: string) =>
    request(app.getHttpServer())
      .get(`/public/websites/${academyId}`)
      .expect(200)
      .then((r) => r.body.brand.palette?.seeds?.primary as string | undefined);

  it('on a published site, saved colours, name and logo are public on the very next read', async () => {
    const a = await seedAcademyWithHost('vi-live');
    await save(a.owner.token, a.academy.id, {
      brand: { palette: palette(ORANGE) },
    }).expect(200);
    await publish(a.owner.token, a.academy.id);
    const before = await getConfig(a.owner.token, a.academy.id);
    // Both reads are now cached (Redis): the old behaviour served these.
    expect(await publicPrimary(a.academy.id)).toBe(ORANGE.primary);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(ORANGE.primary);

    const saved = await save(a.owner.token, a.academy.id, {
      name: 'Renamed Academy',
      logo: 'https://cdn.example.com/new-logo.png',
      brand: { palette: palette(GREEN) },
    }).expect(200);
    expect(saved.body.academy).toMatchObject({
      name: 'Renamed Academy',
      logo: 'https://cdn.example.com/new-logo.png',
    });
    expect(saved.body.configuration.configVersion).toBe(before.configVersion + 1);
    // Identity is live on save: nothing left to publish for it.
    expect(saved.body.configuration.unpublishedChanges.configuration).toBe(false);

    expect(await publicPrimary(a.academy.id)).toBe(GREEN.primary);
    const resolved = await resolve(a.host);
    expect(resolved.presentation?.brand.primaryColor).toBe(GREEN.primary);
    expect(resolved.academyName).toBe('Renamed Academy');
    expect(resolved.academyLogo).toBe('https://cdn.example.com/new-logo.png');
  });

  it('before the first publish, the Coming Soon colours follow the saved ones at once', async () => {
    const a = await seedAcademyWithHost('vi-draft');
    await save(a.owner.token, a.academy.id, {
      brand: { palette: palette(ORANGE) },
    }).expect(200);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(ORANGE.primary);
    await save(a.owner.token, a.academy.id, {
      brand: { palette: palette(GREEN) },
    }).expect(200);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(GREEN.primary);
  });

  it('the settings save and the site publish also drop the cached colours, never serving a stale pair', async () => {
    const a = await seedAcademyWithHost('vi-publish');
    const patchBrand = (seeds: typeof ORANGE) =>
      request(app.getHttpServer())
        .patch(`/academies/${a.academy.id}/website/configuration`)
        .set('Authorization', `Bearer ${a.owner.token}`)
        .send({ brand: { palette: palette(seeds) } })
        .expect(200);
    await patchBrand(ORANGE);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(ORANGE.primary);
    await publish(a.owner.token, a.academy.id);
    // A draft change on a live site stays a draft…
    await patchBrand(GREEN);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(ORANGE.primary);
    // …until it is published, and then it shows on the very next read.
    await publish(a.owner.token, a.academy.id);
    expect((await resolve(a.host)).presentation?.brand.primaryColor).toBe(GREEN.primary);
  });

  it('logo: null removes the logo', async () => {
    const a = await seedAcademyWithHost('vi-remove');
    await save(a.owner.token, a.academy.id, {
      logo: 'https://cdn.example.com/logo.png',
    }).expect(200);
    const removed = await save(a.owner.token, a.academy.id, { logo: null }).expect(200);
    expect(removed.body.academy.logo).toBeUndefined();
    expect((await resolve(a.host)).academyLogo).toBeUndefined();
  });

  it('is atomic: an invalid palette saves nothing — not even the name', async () => {
    const a = await seedAcademyWithHost('vi-atomic');
    const before = await getConfig(a.owner.token, a.academy.id);
    await save(a.owner.token, a.academy.id, {
      name: 'Should Not Stick',
      brand: { palette: { seeds: { primary: 'not-a-colour' } } },
    }).expect(400);
    expect((await resolve(a.host)).academyName).not.toBe('Should Not Stick');
    const after = await getConfig(a.owner.token, a.academy.id);
    expect(after.configVersion).toBe(before.configVersion);
  });

  it('a save based on an older copy is refused and saves nothing', async () => {
    const a = await seedAcademyWithHost('vi-stale');
    const loaded = await getConfig(a.owner.token, a.academy.id);
    await save(a.owner.token, a.academy.id, {
      brand: { palette: palette(ORANGE) },
      expectedUpdatedAt: loaded.updatedAt,
    }).expect(200);
    const stale = await save(a.owner.token, a.academy.id, {
      name: 'Stale',
      brand: { palette: palette(GREEN) },
      expectedUpdatedAt: loaded.updatedAt,
    }).expect(409);
    expect(stale.body.error.code).toBe('stale_resource_version');
    expect((await resolve(a.host)).academyName).not.toBe('Stale');
    expect(
      (await getConfig(a.owner.token, a.academy.id)).brand.palette.seeds.primary,
    ).toBe(ORANGE.primary);
  });

  it("another Academy's owner, an instructor and an anonymous caller are refused; other sites are untouched", async () => {
    const a = await seedAcademyWithHost('vi-iso-a');
    const b = await seedAcademyWithHost('vi-iso-b');
    await save(b.owner.token, b.academy.id, {
      brand: { palette: palette(ORANGE) },
    }).expect(200);

    const outsider = await save(b.owner.token, a.academy.id, { name: 'Hijacked' });
    expect([403, 404]).toContain(outsider.status);

    const instructor = await signUpAndSignIn('vi-iso-instructor');
    await admin.organizationMembership.create({
      data: { organizationId: a.org.id, userId: instructor.userId, role: 'member' },
    });
    await seedAcademyMember(admin, a.academy.id, instructor.userId, 'instructor');
    const asInstructor = await save(instructor.token, a.academy.id, { name: 'Hijacked' });
    expect([403, 404]).toContain(asInstructor.status);

    await save(null, a.academy.id, { name: 'Hijacked' }).expect(401);

    expect((await resolve(a.host)).academyName).not.toBe('Hijacked');
    expect((await resolve(b.host)).presentation?.brand.primaryColor).toBe(ORANGE.primary);
  });
});
