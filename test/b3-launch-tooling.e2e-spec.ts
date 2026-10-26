/**
 * B3 — launch tooling (e2e): the marketing blog, site announcements and
 * the launch checklist, against the real app, Postgres (FORCE RLS, the
 * `atlas_app` role), Redis and the local S3 store.
 *
 *  - Platform Owner only: no token → 401, a tenant owner → 403 on every
 *    management route (the image upload included, before any body parse).
 *  - Public blog: drafts, future scheduled posts and archived posts never
 *    appear (list, detail, sitemap); no internal fields; cache headers;
 *    the parity rule (422) and optimistic concurrency (409) over HTTP.
 *  - Blog image upload: WebP out, served from the public media route.
 *  - Announcements: live window, one pop-up, dashboard audiences, the
 *    beacon (counts live rows only, ignores unknown ids).
 *  - Launch checklist: seeded defaults, done stamps, reorder.
 *  - RLS, proved directly as the application role: a context-less read sees
 *    only public posts / live marketing announcements, no checklist rows,
 *    and cannot write; a non-owner user context cannot write either; the
 *    beacon function counts only live rows.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

jest.setTimeout(180000);

const EN = {
  title: 'Protecting your courses',
  excerpt: 'How Atlas keeps paid lessons for paying students only.',
  body: '# Protect\n\nPaid lessons stay paid. See [pricing](/pricing).',
  seoTitle: 'Protect your courses',
};
const AR = {
  title: 'حماية دوراتك',
  excerpt: 'كيف تحافظ أطلس على الدروس المدفوعة للطلاب الذين دفعوا فقط.',
  body: 'الدروس المدفوعة تبقى مدفوعة.',
};

describe('B3 launch tooling (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let flush: () => Promise<void>;
  let po: { userId: string; accessToken: string };
  let owner: { userId: string; accessToken: string };
  let plain: { userId: string; accessToken: string };
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await http()
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService);
    po = await signUp('b3-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    owner = await signUp('b3-owner');
    await seedOrganizationWithOwner(admin, owner.userId, 'b3-org');
    plain = await signUp('b3-plain');
  });

  beforeEach(async () => {
    await flush();
  });

  afterAll(async () => {
    await admin.platformBlogPost.deleteMany({ where: { slug: { contains: tag } } });
    await admin.siteAnnouncement.deleteMany({ where: { name: { contains: tag } } });
    await admin.launchChecklistItem.deleteMany({ where: { title: { contains: tag } } });
    await admin.$disconnect();
    await app.close();
  });

  function createPost(
    slug: string,
    translations: object = { en: EN, ar: AR },
    extra: object = {},
  ) {
    return http()
      .post('/platform-blog-posts')
      .set(bearer(po.accessToken))
      .send({ slug, kind: 'article', topic: 'protection', translations, ...extra });
  }

  describe('Platform Owner only', () => {
    const routes: [string, string][] = [
      ['get', '/platform-blog-posts'],
      ['post', '/platform-blog-posts'],
      ['get', '/platform-blog-posts/00000000-0000-4000-8000-000000000000'],
      ['patch', '/platform-blog-posts/00000000-0000-4000-8000-000000000000'],
      ['post', '/platform-blog-posts/00000000-0000-4000-8000-000000000000/publish'],
      ['delete', '/platform-blog-posts/00000000-0000-4000-8000-000000000000'],
      ['get', '/platform-blog-posts/00000000-0000-4000-8000-000000000000/preview'],
      ['post', '/platform-blog-images'],
      ['get', '/platform-site-announcements'],
      ['post', '/platform-site-announcements'],
      [
        'post',
        '/platform-site-announcements/00000000-0000-4000-8000-000000000000/activate',
      ],
      ['get', '/platform-launch-checklist'],
      ['post', '/platform-launch-checklist/reorder'],
    ];

    it.each(routes)('%s %s → 401 without a session', async (method, path) => {
      await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .expect(401);
    });

    it.each(routes)('%s %s → 403 for an organization owner', async (method, path) => {
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set(bearer(owner.accessToken))
        .send({});
      expect(res.status).toBe(403);
    });

    it('a non-owner upload is refused before the file is read', async () => {
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#000' },
      })
        .png()
        .toBuffer();
      await http()
        .post('/platform-blog-images')
        .set(bearer(owner.accessToken))
        .attach('file', png, 'x.png')
        .expect(403);
    });
  });

  describe('blog', () => {
    it('draft → parity 422 → publish; public list/detail/sitemap; no leaks; cache headers', async () => {
      const slug = `protect-${tag}`;
      const created = await createPost(slug, { en: EN }).expect(201);
      expect(created.body).toMatchObject({ status: 'draft', version: 1, slug });
      const id = created.body.id as string;

      // Not public while a draft.
      await http().get(`/public/blog/posts/${slug}?locale=en`).expect(404);
      const list0 = await http()
        .get('/public/blog/posts?locale=en&pageSize=24')
        .expect(200);
      expect(list0.body.items.map((p: { slug: string }) => p.slug)).not.toContain(slug);

      // Publishing without Arabic is refused (W2 parity rule).
      const refused = await http()
        .post(`/platform-blog-posts/${id}/publish`)
        .set(bearer(po.accessToken))
        .send({ version: 1 })
        .expect(422);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.blog.translationsIncomplete',
        details: { locales: 'ar' },
      });

      // A stale PATCH is refused.
      const patched = await http()
        .patch(`/platform-blog-posts/${id}`)
        .set(bearer(po.accessToken))
        .send({ version: 1, translations: { ar: AR } })
        .expect(200);
      expect(patched.body.version).toBe(2);
      expect(patched.body.readingMinutes).toEqual({ en: 1, ar: 1 });
      const stale = await http()
        .patch(`/platform-blog-posts/${id}`)
        .set(bearer(po.accessToken))
        .send({ version: 1, featured: true })
        .expect(409);
      expect(stale.body.error).toMatchObject({
        messageKey: 'errors.blog.stale',
        code: 'BLOG_POST_STALE',
      });

      const published = await http()
        .post(`/platform-blog-posts/${id}/publish`)
        .set(bearer(po.accessToken))
        .send({ version: 2 })
        .expect(200);
      expect(published.body).toMatchObject({
        status: 'published',
        isPublic: true,
        version: 3,
      });

      const detail = await http().get(`/public/blog/posts/${slug}?locale=ar`).expect(200);
      expect(detail.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
      expect(detail.body).toMatchObject({
        slug,
        title: AR.title,
        body: AR.body,
        alternateLocaleAvailable: true,
        related: [],
      });
      for (const key of [
        'id',
        'status',
        'version',
        'createdByName',
        'updatedByName',
        'relatedPostIds',
        'translations',
      ]) {
        expect(detail.body).not.toHaveProperty(key);
      }

      const list = await http()
        .get('/public/blog/posts?locale=en&topic=protection&pageSize=24')
        .expect(200);
      expect(list.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
      const row = list.body.items.find((p: { slug: string }) => p.slug === slug);
      expect(row).toMatchObject({
        title: EN.title,
        readingMinutes: 1,
        authorName: 'Atlas team',
      });
      expect(Object.keys(row).sort()).toEqual(
        [
          'authorName',
          'coverAlt',
          'coverImage',
          'excerpt',
          'featured',
          'kind',
          'publishAt',
          'readingMinutes',
          'slug',
          'title',
          'topic',
          'updatedAt',
        ].sort(),
      );
      expect(list.body.pagination).toMatchObject({ page: 1, pageSize: 24 });

      const sitemap = await http().get('/public/blog/sitemap').expect(200);
      expect(sitemap.body.items).toContainEqual(
        expect.objectContaining({ slug, locales: ['en', 'ar'] }),
      );

      // Archive → gone from the public site; an error is never cached publicly.
      await http()
        .post(`/platform-blog-posts/${id}/archive`)
        .set(bearer(po.accessToken))
        .send({ version: 3 })
        .expect(200);
      const gone = await http().get(`/public/blog/posts/${slug}?locale=en`).expect(404);
      expect(gone.headers['cache-control']).toBe('private, no-store');
      const sitemap2 = await http().get('/public/blog/sitemap').expect(200);
      expect(sitemap2.body.items.map((i: { slug: string }) => i.slug)).not.toContain(
        slug,
      );

      // Delete (archived posts only, or drafts).
      await http()
        .delete(`/platform-blog-posts/${id}`)
        .set(bearer(po.accessToken))
        .expect(204);
    });

    it('a scheduled post stays private until its time', async () => {
      const slug = `scheduled-${tag}`;
      const created = await createPost(slug).expect(201);
      const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const scheduled = await http()
        .post(`/platform-blog-posts/${created.body.id}/publish`)
        .set(bearer(po.accessToken))
        .send({ version: 1, publishAt: future })
        .expect(200);
      expect(scheduled.body).toMatchObject({ status: 'scheduled', isPublic: false });
      await http().get(`/public/blog/posts/${slug}`).expect(404);
      const sitemap = await http().get('/public/blog/sitemap').expect(200);
      expect(sitemap.body.items.map((i: { slug: string }) => i.slug)).not.toContain(slug);

      // Its time comes (moved into the past directly): now public.
      await admin.platformBlogPost.update({
        where: { id: created.body.id },
        data: { publishAt: new Date(Date.now() - 1000) },
      });
      await http().get(`/public/blog/posts/${slug}`).expect(200);
    });

    it('preview returns the public shape for a draft; slug and markdown rules apply', async () => {
      const slug = `preview-${tag}`;
      const created = await createPost(slug).expect(201);
      const preview = await http()
        .get(`/platform-blog-posts/${created.body.id}/preview?locale=en`)
        .set(bearer(po.accessToken))
        .expect(200);
      expect(preview.body).toMatchObject({ slug, title: EN.title, body: EN.body });

      const taken = await createPost(slug).expect(409);
      expect(taken.body.error.messageKey).toBe('errors.blog.slugTaken');
      const unsafe = await createPost(`unsafe-${tag}`, {
        en: { ...EN, body: '[click](javascript:alert(1))' },
      }).expect(400);
      expect(unsafe.body.error.messageKey).toBe('errors.blog.unsafeMarkdownUrl');
      await createPost(
        `cover-${tag}`,
        { en: EN },
        {
          coverImage: { url: 'javascript:alert(1)', width: 10, height: 10 },
        },
      ).expect(400);
    });

    it('uploads an image as WebP and serves it publicly', async () => {
      const png = await sharp({
        create: { width: 1600, height: 900, channels: 3, background: '#1478c8' },
      })
        .png()
        .toBuffer();
      const res = await http()
        .post('/platform-blog-images')
        .set(bearer(po.accessToken))
        .attach('file', png, 'cover.png')
        .expect(201);
      expect(res.body).toMatchObject({ width: 1600, height: 900 });
      expect(res.body.url).toMatch(
        /^\/api\/v1\/public\/media\/platform\/blog\/[0-9a-f-]{36}\.webp$/,
      );
      const served = await http()
        .get(res.body.url.replace('/api/v1', ''))
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(served.headers['content-type']).toBe('image/webp');
      expect(served.headers['cache-control']).toContain('immutable');
      expect((served.body as Buffer).subarray(8, 12).toString('latin1')).toBe('WEBP');

      const bad = await http()
        .post('/platform-blog-images')
        .set(bearer(po.accessToken))
        .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg')
        .expect(400);
      expect(bad.body.error.messageKey).toBe('errors.blog.imageInvalid');
      await http().get('/public/media/platform/blog/not-a-uuid.webp').expect(404);
      await http()
        .get('/public/media/platform/blog/00000000-0000-4000-8000-000000000000.webp')
        .expect(404);
    });
  });

  describe('site announcements', () => {
    async function createAnnouncement(body: object) {
      const res = await http()
        .post('/platform-site-announcements')
        .set(bearer(po.accessToken))
        .send(body)
        .expect(201);
      return res.body as { id: string; version: number };
    }
    function activate(id: string, version = 1) {
      return http()
        .post(`/platform-site-announcements/${id}/activate`)
        .set(bearer(po.accessToken))
        .send({ version });
    }

    it('marketing: live only, one pop-up (highest priority), locale and page aware', async () => {
      const banner = await createAnnouncement({
        name: `banner-${tag}`,
        surface: 'marketing_banner',
        priority: 100,
        pages: ['/pricing'],
        ctaUrl: '/founding',
        content: { en: { body: 'Atlas is live.', ctaLabel: 'Founding seats' } },
      });
      const lowPopup = await createAnnouncement({
        name: `popup-low-${tag}`,
        surface: 'marketing_popup',
        priority: 98,
        content: { en: { title: 'Low', body: 'Low popup' } },
      });
      const highPopup = await createAnnouncement({
        name: `popup-high-${tag}`,
        surface: 'marketing_popup',
        priority: 99,
        popupDelaySeconds: 5,
        content: { en: { title: 'High', body: 'High popup' } },
      });
      const draftBanner = await createAnnouncement({
        name: `draft-${tag}`,
        surface: 'marketing_banner',
        priority: 100,
        content: { en: { body: 'never shown' } },
      });
      const dashboardBanner = await createAnnouncement({
        name: `dash-${tag}`,
        surface: 'dashboard_banner',
        priority: 100,
        audience: 'organization_owners',
        content: { en: { body: `owners-${tag}` } },
      });
      for (const ann of [banner, lowPopup, highPopup, dashboardBanner]) {
        await activate(ann.id).expect(200);
      }

      const page = await http()
        .get('/public/site-announcements?surface=marketing&locale=en&path=/ar/pricing')
        .expect(200);
      expect(page.headers['cache-control']).toBe('public, max-age=30, s-maxage=60');
      const bannerIds = page.body.banners.map((b: { id: string }) => b.id);
      expect(bannerIds).toContain(banner.id);
      expect(bannerIds).not.toContain(draftBanner.id);
      expect(bannerIds).not.toContain(dashboardBanner.id);
      expect(page.body.popup).toMatchObject({
        id: highPopup.id,
        title: 'High',
        popupDelaySeconds: 5,
      });
      for (const key of [
        'name',
        'views',
        'clicks',
        'dismissals',
        'status',
        'version',
        'pages',
        'audience',
      ]) {
        expect(page.body.popup).not.toHaveProperty(key);
      }

      // Another page / another language.
      const blog = await http()
        .get('/public/site-announcements?surface=marketing&locale=en&path=/blog')
        .expect(200);
      expect(blog.body.banners.map((b: { id: string }) => b.id)).not.toContain(banner.id);
      const arabic = await http()
        .get('/public/site-announcements?surface=marketing&locale=ar&path=/pricing')
        .expect(200);
      expect(arabic.body.banners.map((b: { id: string }) => b.id)).not.toContain(
        banner.id,
      );
      await http().get('/public/site-announcements?surface=dashboard').expect(400);

      // The beacon: live rows count, anything else is silently ignored.
      await http()
        .post(`/public/site-announcements/${banner.id}/events`)
        .send({ type: 'view' })
        .expect(204);
      await http()
        .post(`/public/site-announcements/${banner.id}/events`)
        .send({ type: 'click' })
        .expect(204);
      await http()
        .post(`/public/site-announcements/${draftBanner.id}/events`)
        .send({ type: 'view' })
        .expect(204);
      await http()
        .post('/public/site-announcements/not-a-uuid/events')
        .send({ type: 'view' })
        .expect(204);
      await http()
        .post('/public/site-announcements/00000000-0000-4000-8000-000000000000/events')
        .send({ type: 'dismiss' })
        .expect(204);
      await http()
        .post(`/public/site-announcements/${banner.id}/events`)
        .send({ type: 'hack' })
        .expect(400);
      const counted = await admin.siteAnnouncement.findUniqueOrThrow({
        where: { id: banner.id },
      });
      expect([counted.views, counted.clicks, counted.dismissals]).toEqual([1, 1, 0]);
      expect(counted.version).toBe(2);
      const notCounted = await admin.siteAnnouncement.findUniqueOrThrow({
        where: { id: draftBanner.id },
      });
      expect(notCounted.views).toBe(0);
      const stats = await http()
        .get(`/platform-site-announcements/${banner.id}`)
        .set(bearer(po.accessToken))
        .expect(200);
      expect(stats.body.stats).toEqual({ views: 1, clicks: 1, dismissals: 0 });

      // Dashboard: audience-filtered, learners/anonymous never.
      const ownerView = await http()
        .get('/site-announcements/dashboard?locale=en')
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(ownerView.body.banners.map((b: { body: string }) => b.body)).toContain(
        `owners-${tag}`,
      );
      const plainView = await http()
        .get('/site-announcements/dashboard?locale=en')
        .set(bearer(plain.accessToken))
        .expect(200);
      expect(plainView.body.banners.map((b: { body: string }) => b.body)).not.toContain(
        `owners-${tag}`,
      );
      await http().get('/site-announcements/dashboard').expect(401);

      // Ended window → gone; delete needs draft/archived.
      await http()
        .patch(`/platform-site-announcements/${banner.id}`)
        .set(bearer(po.accessToken))
        .send({ version: 2, endsAt: new Date(Date.now() - 1000).toISOString() })
        .expect(200);
      const after = await http()
        .get('/public/site-announcements?surface=marketing&locale=en&path=/pricing')
        .expect(200);
      expect(after.body.banners.map((b: { id: string }) => b.id)).not.toContain(
        banner.id,
      );
      await http()
        .delete(`/platform-site-announcements/${banner.id}`)
        .set(bearer(po.accessToken))
        .expect(409);
      await http()
        .post(`/platform-site-announcements/${banner.id}/archive`)
        .set(bearer(po.accessToken))
        .send({ version: 3 })
        .expect(200);
      await http()
        .delete(`/platform-site-announcements/${banner.id}`)
        .set(bearer(po.accessToken))
        .expect(204);

      // Clean up the live ones so later runs start clear.
      for (const ann of [lowPopup, highPopup, dashboardBanner]) {
        await http()
          .post(`/platform-site-announcements/${ann.id}/deactivate`)
          .set(bearer(po.accessToken))
          .send({ version: 2 })
          .expect(200);
      }
    });

    it('activation rules and unsafe URLs are refused', async () => {
      const empty = await createAnnouncement({
        name: `empty-${tag}`,
        surface: 'marketing_banner',
      });
      const res = await activate(empty.id).expect(422);
      expect(res.body.error.messageKey).toBe('errors.siteAnnouncements.contentRequired');
      await http()
        .post('/platform-site-announcements')
        .set(bearer(po.accessToken))
        .send({
          name: `bad-${tag}`,
          surface: 'marketing_banner',
          ctaUrl: 'javascript:alert(1)',
        })
        .expect(400);
      await http()
        .post('/platform-site-announcements')
        .set(bearer(po.accessToken))
        .send({
          name: `html-${tag}`,
          surface: 'marketing_banner',
          content: { en: { body: '<b>hi</b>' } },
        })
        .expect(400);
    });
  });

  describe('launch checklist', () => {
    it('has the seeded defaults (restore drill done 26 Oct), toggles and reorders', async () => {
      const list = await http()
        .get('/platform-launch-checklist')
        .set(bearer(po.accessToken))
        .expect(200);
      expect(list.body.items.length).toBeGreaterThanOrEqual(18);
      const drill = list.body.items.find(
        (i: { title: string }) => i.title === 'Restore drill done',
      );
      expect(drill).toMatchObject({
        done: true,
        doneAt: '2026-10-26T00:00:00.000Z',
        section: 'operations',
      });
      expect(list.body.progress.total).toBe(list.body.items.length);

      const created = await http()
        .post('/platform-launch-checklist')
        .set(bearer(po.accessToken))
        .send({
          section: 'content',
          title: `extra-${tag}`,
          linkUrl: '/dashboard/platform/blog',
        })
        .expect(201);
      const toggled = await http()
        .patch(`/platform-launch-checklist/${created.body.id}`)
        .set(bearer(po.accessToken))
        .send({ version: 1, done: true })
        .expect(200);
      expect(toggled.body).toMatchObject({ done: true, doneByName: 'b3-po', version: 2 });
      await http()
        .patch(`/platform-launch-checklist/${created.body.id}`)
        .set(bearer(po.accessToken))
        .send({ version: 1, notes: 'stale' })
        .expect(409);

      const all = await http()
        .get('/platform-launch-checklist')
        .set(bearer(po.accessToken))
        .expect(200);
      const ids = all.body.items.map((i: { id: string }) => i.id) as string[];
      const reversed = [...ids].reverse();
      const reordered = await http()
        .post('/platform-launch-checklist/reorder')
        .set(bearer(po.accessToken))
        .send({ ids: reversed })
        .expect(200);
      expect(reordered.body.items.map((i: { id: string }) => i.id)).toEqual(reversed);
      await http()
        .post('/platform-launch-checklist/reorder')
        .set(bearer(po.accessToken))
        .send({ ids: reversed.slice(1) })
        .expect(400);
      await http()
        .post('/platform-launch-checklist/reorder')
        .set(bearer(po.accessToken))
        .send({ ids })
        .expect(200);
      await http()
        .delete(`/platform-launch-checklist/${created.body.id}`)
        .set(bearer(po.accessToken))
        .expect(204);
    });
  });

  describe('RLS (as the application role)', () => {
    it('a context-less read sees only public posts and cannot write', async () => {
      const draft = await createPost(`rls-draft-${tag}`).expect(201);
      const visible = await tenancy.runWithoutContext((tx) =>
        tx.platformBlogPost.findMany({
          where: { slug: { contains: tag } },
          select: { slug: true, status: true },
        }),
      );
      expect(visible.map((row) => row.slug)).not.toContain(`rls-draft-${tag}`);
      expect(
        visible.every((row) => row.status === 'published' || row.status === 'scheduled'),
      ).toBe(true);

      await expect(
        tenancy.runWithoutContext((tx) =>
          tx.platformBlogPost.create({
            data: {
              slug: `rls-insert-${tag}`,
              kind: 'article',
              topic: 'news',
              createdByUserId: plain.userId,
              updatedByUserId: plain.userId,
            },
          }),
        ),
      ).rejects.toThrow();
      const updated = await tenancy.runWithoutContext(
        (tx) =>
          tx.$executeRaw`UPDATE platform_blog_posts SET featured = true WHERE id = ${draft.body.id}`,
      );
      expect(updated).toBe(0);
    });

    it('a signed-in non-owner sees no drafts, no checklist and writes nothing', async () => {
      const rows = await tenancy.runInUserContext(plain.userId, async (tx) => ({
        drafts: await tx.platformBlogPost.count({ where: { status: 'draft' } }),
        checklist: await tx.launchChecklistItem.count(),
        drafted: await tx.siteAnnouncement.count({ where: { status: 'draft' } }),
        blogUpdate: await tx.$executeRaw`UPDATE platform_blog_posts SET featured = true`,
        checklistUpdate:
          await tx.$executeRaw`UPDATE launch_checklist_items SET done = true`,
        announcementUpdate:
          await tx.$executeRaw`UPDATE site_announcements SET priority = 1`,
      }));
      expect(rows).toEqual({
        drafts: 0,
        checklist: 0,
        drafted: 0,
        blogUpdate: 0,
        checklistUpdate: 0,
        announcementUpdate: 0,
      });
      const anonymousChecklist = await tenancy.runWithoutContext((tx) =>
        tx.launchChecklistItem.count(),
      );
      expect(anonymousChecklist).toBe(0);
      const poChecklist = await tenancy.runInUserContext(po.userId, (tx) =>
        tx.launchChecklistItem.count(),
      );
      expect(poChecklist).toBeGreaterThanOrEqual(18);
    });

    it('a live dashboard banner needs a user context; the beacon counts live rows only', async () => {
      const created = await http()
        .post('/platform-site-announcements')
        .set(bearer(po.accessToken))
        .send({
          name: `rls-dash-${tag}`,
          surface: 'dashboard_banner',
          content: { en: { body: 'rls' } },
        })
        .expect(201);
      const id = created.body.id as string;
      const countDraft = await tenancy.runWithoutContext(
        (tx) =>
          tx.$queryRaw<
            { n: number }[]
          >`SELECT record_site_announcement_event(${id}, 'view') AS n`,
      );
      expect(Number(countDraft[0].n)).toBe(0);
      await http()
        .post(`/platform-site-announcements/${id}/activate`)
        .set(bearer(po.accessToken))
        .send({ version: 1 })
        .expect(200);
      const anonymous = await tenancy.runWithoutContext((tx) =>
        tx.siteAnnouncement.count({ where: { id } }),
      );
      const signedIn = await tenancy.runInUserContext(plain.userId, (tx) =>
        tx.siteAnnouncement.count({ where: { id } }),
      );
      expect([anonymous, signedIn]).toEqual([0, 1]);
      const countLive = await tenancy.runWithoutContext(
        (tx) =>
          tx.$queryRaw<
            { n: number }[]
          >`SELECT record_site_announcement_event(${id}, 'view') AS n`,
      );
      expect(Number(countLive[0].n)).toBe(1);
      await http()
        .post(`/platform-site-announcements/${id}/deactivate`)
        .set(bearer(po.accessToken))
        .send({ version: 2 })
        .expect(200);
    });
  });
});
