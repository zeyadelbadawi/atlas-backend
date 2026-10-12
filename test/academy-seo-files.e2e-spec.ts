/**
 * B0-WEB-01 — an Academy host serves its OWN robots.txt and sitemap.xml
 * (`GET /public/websites/host/robots.txt|sitemap.xml`, reached through
 * Caddy with the visitor's host in `X-Forwarded-Host`), never the
 * platform's, and the Academy's indexing and sitemap settings are honoured.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';

jest.setTimeout(30000);

describe('Academy robots.txt and sitemap.xml (e2e) — B0-WEB-01', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  async function academyWithHost(label: string, publish: boolean) {
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
    const token = signIn.body.accessToken as string;
    const org = await seedOrganizationWithOwner(
      admin,
      signIn.body.user.id,
      `${label}-org`,
    );
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, signIn.body.user.id, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.seo.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    if (publish) {
      await request(app.getHttpServer())
        .get(`/academies/${academy.id}/website/configuration`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // One real, visible page with content, through the editor API.
      const page = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/pages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'About us', slug: 'about-us' })
        .expect(201);
      const current = await request(app.getHttpServer())
        .get(`/academies/${academy.id}/website/pages/${page.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/academies/${academy.id}/website/pages/${page.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          visible: true,
          sections: [
            {
              id: 'sec-hero',
              type: 'hero',
              enabled: true,
              visibility: { desktop: true, tablet: true, mobile: true },
              config: { title: 'About us' },
            },
          ],
          expectedVersion: current.body.version,
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/publish`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
    }
    return { academyId: academy.id, host, token };
  }

  const robots = (host: string) =>
    request(app.getHttpServer())
      .get('/public/websites/host/robots.txt')
      .set('X-Forwarded-Host', host);
  const sitemap = (host: string) =>
    request(app.getHttpServer())
      .get('/public/websites/host/sitemap.xml')
      .set('X-Forwarded-Host', host);

  it('a published academy allows indexing and links its own sitemap on its own host', async () => {
    const { academyId, host } = await academyWithHost('seo-pub', true);
    const course = await seedCourse(admin, academyId, `seo-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    await seedCourse(admin, academyId, `seo-draft-${Date.now()}`, {
      status: 'draft',
      visibility: 'private',
    });

    const r = await robots(host).expect(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toContain('Allow: /');
    expect(r.text).toContain(`Sitemap: https://${host}/sitemap.xml`);
    expect(r.text).not.toContain('atlass.dpdns.org');

    const s = await sitemap(host).expect(200);
    expect(s.headers['content-type']).toMatch(/^application\/xml/);
    expect(s.text).toContain(`<loc>https://${host}/about-us</loc>`);
    expect(s.text).toContain(`hreflang="ar" href="https://${host}/ar/about-us"`);
    expect(s.text).toContain(`<loc>https://${host}/courses/${course.slug}</loc>`);
    expect(s.text).not.toContain('seo-draft-');
  });

  it('an unpublished (Coming Soon) academy disallows everything and has no sitemap', async () => {
    const { host } = await academyWithHost('seo-soon', false);
    const r = await robots(host).expect(200);
    expect(r.text).toBe('User-agent: *\nDisallow: /\n');
    await sitemap(host).expect(404);
  });

  it('an unknown host disallows everything and has no sitemap', async () => {
    const r = await robots(`nobody-${Date.now()}.seo.test`).expect(200);
    expect(r.text).toBe('User-agent: *\nDisallow: /\n');
    await sitemap(`nobody-${Date.now()}.seo.test`).expect(404);
  });

  it('honours "do not index" and "no sitemap" from the published settings', async () => {
    const { academyId, host } = await academyWithHost('seo-off', true);
    const row = await admin.websiteConfiguration.findFirstOrThrow({
      where: { academyId, status: 'published' },
    });
    const snapshot = (row.publishedSnapshot ?? {}) as Record<string, unknown>;
    const seo = (snapshot.seo ?? {}) as Record<string, unknown>;
    await admin.websiteConfiguration.update({
      where: { academyId },
      data: {
        configVersion: row.configVersion + 1,
        publishedSnapshot: { ...snapshot, seo: { ...seo, sitemapEnabled: false } },
        seo: { ...((row.seo ?? {}) as Record<string, unknown>), sitemapEnabled: false },
      },
    });
    const noSitemap = await robots(host).expect(200);
    expect(noSitemap.text).toBe('User-agent: *\nAllow: /\n');
    await sitemap(host).expect(404);

    await admin.websiteConfiguration.update({
      where: { academyId },
      data: {
        configVersion: row.configVersion + 2,
        publishedSnapshot: { ...snapshot, seo: { ...seo, robotsIndexable: false } },
        seo: { ...((row.seo ?? {}) as Record<string, unknown>), robotsIndexable: false },
      },
    });
    const closed = await robots(host).expect(200);
    expect(closed.text).toBe('User-agent: *\nDisallow: /\n');
    await sitemap(host).expect(404);
  });
});
