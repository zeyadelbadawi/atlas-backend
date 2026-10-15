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
  seedMembership,
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

  it('keeps a stable page order when a publish rewrites the rows (no heap-order dependence)', async () => {
    const { academyId, host, token } = await academyWithHost('seo-order', true);
    const locs = (xml: string) =>
      [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const before = locs((await sitemap(host).expect(200)).text);
    expect(before[0]).toBe(`https://${host}/`);
    expect(before).toContain(`https://${host}/about-us`);

    // Rewrite the home page's row with a non-HOT update (an indexed column
    // changes, then is restored): its new tuple and index entries land after
    // every other page's, so an unordered read would now list it last.
    const home = await admin.websitePage.findFirstOrThrow({
      where: { academyId, coreType: 'home' },
    });
    await admin.websitePage.update({
      where: { id: home.id },
      data: { slug: `${home.slug}-moved` },
    });
    await admin.websitePage.update({ where: { id: home.id }, data: { slug: home.slug } });
    await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    expect(locs((await sitemap(host).expect(200)).text)).toEqual(before);
  });

  describe('B0-WEB-02 — Arabic as the default language', () => {
    const patchConfig = (academyId: string, token: string, body: object) =>
      request(app.getHttpServer())
        .patch(`/academies/${academyId}/website/configuration`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    const publish = (academyId: string, token: string) =>
      request(app.getHttpServer())
        .post(`/academies/${academyId}/website/publish`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);

    it('an Arabic-default site lists Arabic at the root and English under /en, live only once published; switching back restores the English sitemap exactly', async () => {
      const { academyId, host, token } = await academyWithHost('seo-ar', true);
      const english = (await sitemap(host).expect(200)).text;
      expect(english).toContain(`<loc>https://${host}/about-us</loc>`);

      const saved = await patchConfig(academyId, token, { defaultLocale: 'ar' }).expect(
        200,
      );
      expect(saved.body.defaultLocale).toBe('ar');
      expect(saved.body.unpublishedChanges.configuration).toBe(true);
      // Saved, not published: visitors still get the English-default site.
      expect((await sitemap(host).expect(200)).text).toBe(english);
      const draftPublic = await request(app.getHttpServer())
        .get(`/public/websites/${academyId}`)
        .expect(200);
      expect(draftPublic.body).not.toHaveProperty('defaultLocale');

      await publish(academyId, token);
      const arabic = (await sitemap(host).expect(200)).text;
      expect(arabic).toContain(`<loc>https://${host}/about-us</loc>`);
      expect(arabic).toContain(`hreflang="ar" href="https://${host}/about-us"`);
      expect(arabic).toContain(`hreflang="en" href="https://${host}/en/about-us"`);
      expect(arabic).toContain(`hreflang="x-default" href="https://${host}/about-us"`);
      expect(arabic).not.toContain(`https://${host}/ar`);
      const live = await request(app.getHttpServer())
        .get(`/public/websites/${academyId}`)
        .expect(200);
      expect(live.body.defaultLocale).toBe('ar');
      // robots.txt is unchanged by the language.
      expect((await robots(host).expect(200)).text).toContain(
        `Sitemap: https://${host}/sitemap.xml`,
      );

      await patchConfig(academyId, token, { defaultLocale: 'en' }).expect(200);
      await publish(academyId, token);
      expect((await sitemap(host).expect(200)).text).toBe(english);
      const back = await request(app.getHttpServer())
        .get(`/public/websites/${academyId}`)
        .expect(200);
      expect(back.body).not.toHaveProperty('defaultLocale');
    });

    it('the required language follows the default: Arabic required on an Arabic-default site, English otherwise', async () => {
      const { academyId, token } = await academyWithHost('seo-req', false);
      const page = await request(app.getHttpServer())
        .post(`/academies/${academyId}/website/pages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Arabic only', slug: 'arabic-only' })
        .expect(201);
      const save = async (title: object, expected: number) => {
        const current = await request(app.getHttpServer())
          .get(`/academies/${academyId}/website/pages/${page.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        return request(app.getHttpServer())
          .patch(`/academies/${academyId}/website/pages/${page.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            sections: [
              {
                id: 'sec-hero',
                type: 'hero',
                enabled: true,
                visibility: { desktop: true, tablet: true, mobile: true },
                config: { title },
              },
            ],
            expectedVersion: current.body.version,
          })
          .expect(expected);
      };
      const arabicOnly = { en: '', ar: 'أهلاً بكم' };
      const englishOnly = { en: 'Welcome', ar: '' };

      const refused = await save(arabicOnly, 400);
      expect(refused.body.error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: '0.config.title.en',
            messageKey: 'validation:required',
          }),
        ]),
      );
      await save(englishOnly, 200);

      await patchConfig(academyId, token, { defaultLocale: 'ar' }).expect(200);
      await save(arabicOnly, 200);
      const refusedEnglish = await save(englishOnly, 400);
      expect(refusedEnglish.body.error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: '0.config.title.ar',
            messageKey: 'validation:required',
          }),
        ]),
      );
      // Published, the Arabic-only title also reads on the /en pages (a
      // blank English side shows its Arabic), never as an empty heading.
      await save(arabicOnly, 200);
      await request(app.getHttpServer())
        .post(`/academies/${academyId}/website/publish`)
        .set('Authorization', `Bearer ${token}`)
        .expect(201);
      const publicPage = await request(app.getHttpServer())
        .get(`/public/websites/${academyId}/pages/arabic-only`)
        .expect(200);
      expect(publicPage.body.sections[0].config.title).toEqual({
        en: 'أهلاً بكم',
        ar: 'أهلاً بكم',
      });
      const draftPage = await request(app.getHttpServer())
        .get(`/academies/${academyId}/website/pages/${page.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(draftPage.body.sections[0].config.title).toEqual(arabicOnly);
      // Navigation labels follow the same rule, in the same save as the switch too.
      await patchConfig(academyId, token, {
        defaultLocale: 'en',
        navigation: [{ id: 'n1', label: arabicOnly, pageId: page.body.id, order: 0 }],
      }).expect(400);
      await patchConfig(academyId, token, {
        navigation: [{ id: 'n1', label: arabicOnly, pageId: page.body.id, order: 0 }],
      }).expect(200);
    });

    it('rejects any other value, and only the website-managing roles may change it', async () => {
      const { academyId, token } = await academyWithHost('seo-rbac', false);
      await request(app.getHttpServer())
        .get(`/academies/${academyId}/website/configuration`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await patchConfig(academyId, token, { defaultLocale: 'fr' }).expect(400);

      const email = uniqueTestEmail('seo-instructor');
      const password = 'correct-horse-battery';
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ name: 'Instructor', email, password })
        .expect(201);
      const signIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send({ email, password })
        .expect(200);
      const academy = await admin.academy.findUniqueOrThrow({ where: { id: academyId } });
      await seedMembership(admin, academy.organizationId, signIn.body.user.id, 'member');
      await seedAcademyMember(admin, academyId, signIn.body.user.id, 'instructor');
      await patchConfig(academyId, signIn.body.accessToken as string, {
        defaultLocale: 'ar',
      }).expect(403);
      const row = await admin.websiteConfiguration.findUniqueOrThrow({
        where: { academyId },
      });
      expect(row.defaultLocale).toBe('en');
    });
  });
});
