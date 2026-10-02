/**
 * Real draft/publish for Academy websites (2 Oct 2026).
 *
 * Before this, the public site read the live working copy: a saved edit
 * went public within the pages cache's TTL with no publish at all, and an
 * Owner who republished the whole site "to make a page change appear" was
 * only bumping the cache key. Pinned here against the real database (RLS,
 * the published columns, the Redis cache):
 *   - saving a page or the site settings changes NOTHING public, at once or
 *     after any cache — the management API reports the pending changes;
 *   - publishing ONE page makes exactly that page's saved state public, on
 *     the very next read, and leaves other pages and the site settings as
 *     they were published;
 *   - hiding or adding a page takes effect publicly only when it is
 *     published;
 *   - publishing the site makes everything public;
 *   - another Academy is never affected, and both languages survive.
 */
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
import { RedisService } from '../src/redis/redis.service';

const lt = (en: string) => ({ en, ar: `${en} (ar)` });
const visibility = { desktop: true, tablet: true, mobile: true };

interface PublicPage {
  id: string;
  slug: string;
  title: string;
  sections: { id: string; config: Record<string, unknown> }[];
}

describe('Website draft/publish (e2e)', () => {
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

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, academy };
  }

  const api = (token: string) => ({
    post: (url: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (url: string, body: object) =>
      request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
  });

  const faqSection = (question: string) => ({
    id: 'faq',
    type: 'faq',
    enabled: true,
    visibility,
    config: {
      items: [{ id: 'q1', question: lt(question), answer: lt(`${question} answer`) }],
    },
  });

  async function publicPages(academyId: string): Promise<PublicPage[]> {
    const response = await request(app.getHttpServer())
      .get(`/public/websites/${academyId}/pages`)
      .expect(200);
    return response.body as PublicPage[];
  }

  async function publicQuestion(academyId: string, slug: string) {
    const page = (await publicPages(academyId)).find((p) => p.slug === slug);
    if (!page) return undefined;
    const faq = page.sections.find((s) => s.id === 'faq');
    return (faq?.config.items as { question: { en: string; ar: string } }[])[0].question;
  }

  async function publicConfiguration(academyId: string) {
    return (
      await request(app.getHttpServer()).get(`/public/websites/${academyId}`).expect(200)
    ).body as { brand: Record<string, unknown>; seo: Record<string, unknown> };
  }

  async function createPage(token: string, base: string, slug: string, question: string) {
    const page = await api(token)
      .post(`${base}/pages`, { title: `${slug} title`, slug })
      .expect(201);
    const version = (await api(token).get(`${base}/pages/${page.body.id}`).expect(200))
      .body.version as number;
    await api(token)
      .patch(`${base}/pages/${page.body.id}`, {
        visible: true,
        expectedVersion: version,
        sections: [faqSection(question)],
      })
      .expect(200);
    return page.body.id as string;
  }

  async function editPage(
    token: string,
    base: string,
    pageId: string,
    changes: Record<string, unknown>,
  ) {
    const version = (await api(token).get(`${base}/pages/${pageId}`).expect(200)).body
      .version as number;
    return api(token)
      .patch(`${base}/pages/${pageId}`, { ...changes, expectedVersion: version })
      .expect(200);
  }

  it('keeps saved edits private until published, page by page or site-wide', async () => {
    const { owner, academy } = await seedManagedAcademy('draft-pub');
    const other = await seedManagedAcademy('draft-pub-other');
    const base = `/academies/${academy.id}/website`;
    const otherBase = `/academies/${other.academy.id}/website`;

    const alpha = await createPage(owner.token, base, 'alpha', 'Alpha A');
    const beta = await createPage(owner.token, base, 'beta', 'Beta A');
    await api(owner.token)
      .patch(`${base}/configuration`, {
        brand: { primaryColor: '210 40% 20%' },
        seo: { siteTitle: lt('Site A') },
      })
      .expect(200);
    await api(owner.token).post(`${base}/publish`).expect(201);
    const otherPage = await createPage(other.owner.token, otherBase, 'alpha', 'Other A');
    await api(other.owner.token).post(`${otherBase}/publish`).expect(201);

    expect(await publicQuestion(academy.id, 'alpha')).toEqual(lt('Alpha A'));
    expect(await publicQuestion(academy.id, 'beta')).toEqual(lt('Beta A'));
    expect((await publicConfiguration(academy.id)).brand.primaryColor).toBe(
      '210 40% 20%',
    );
    let managed = await api(owner.token).get(`${base}/configuration`).expect(200);
    expect(managed.body.unpublishedChanges).toEqual({ configuration: false, pages: 0 });

    // Save edits to both pages and to the site settings. Read once BEFORE the
    // edits too, so the Redis pages/config cache is warm: the public output
    // must not change because the published copy did not, not because a
    // cache happened to be cold.
    await editPage(owner.token, base, alpha, { sections: [faqSection('Alpha B')] });
    await editPage(owner.token, base, beta, {
      title: 'beta renamed',
      sections: [faqSection('Beta B')],
    });
    await api(owner.token)
      .patch(`${base}/configuration`, { brand: { primaryColor: '20 60% 45%' } })
      .expect(200);

    expect(await publicQuestion(academy.id, 'alpha')).toEqual(lt('Alpha A'));
    expect(await publicQuestion(academy.id, 'beta')).toEqual(lt('Beta A'));
    expect((await publicPages(academy.id)).find((p) => p.slug === 'beta')!.title).toBe(
      'beta title',
    );
    expect((await publicConfiguration(academy.id)).brand.primaryColor).toBe(
      '210 40% 20%',
    );
    // With this Academy's public cache entries deleted, the database itself
    // serves the published copy.
    const redis = app.get(RedisService, { strict: false }).getClient();
    const cached = await redis.keys(`public:*:${academy.id}:*`);
    expect(cached.length).toBeGreaterThan(0);
    await redis.del(...cached);
    expect(await publicQuestion(academy.id, 'alpha')).toEqual(lt('Alpha A'));
    expect((await publicConfiguration(academy.id)).brand.primaryColor).toBe(
      '210 40% 20%',
    );
    managed = await api(owner.token).get(`${base}/configuration`).expect(200);
    expect(managed.body.unpublishedChanges).toEqual({ configuration: true, pages: 2 });
    const alphaManaged = await api(owner.token).get(`${base}/pages/${alpha}`).expect(200);
    expect(alphaManaged.body.hasUnpublishedChanges).toBe(true);
    // The editor still loads the working copy.
    expect(alphaManaged.body.sections[0].config.items[0].question).toEqual(lt('Alpha B'));

    // Publish ONE page: exactly that page goes public, immediately.
    const published = await api(owner.token)
      .post(`${base}/pages/${alpha}/publish`)
      .expect(201);
    expect(published.body.hasUnpublishedChanges).toBe(false);
    expect(published.body.publishedAt).toEqual(expect.any(String));
    expect(await publicQuestion(academy.id, 'alpha')).toEqual(lt('Alpha B'));
    expect(await publicQuestion(academy.id, 'beta')).toEqual(lt('Beta A'));
    expect((await publicConfiguration(academy.id)).brand.primaryColor).toBe(
      '210 40% 20%',
    );
    managed = await api(owner.token).get(`${base}/configuration`).expect(200);
    expect(managed.body.unpublishedChanges).toEqual({ configuration: true, pages: 1 });

    // Hiding a page is a draft change too: it stays live until published.
    await editPage(owner.token, base, alpha, { visible: false });
    expect(await publicQuestion(academy.id, 'alpha')).toEqual(lt('Alpha B'));
    await api(owner.token).post(`${base}/pages/${alpha}/publish`).expect(201);
    expect(await publicQuestion(academy.id, 'alpha')).toBeUndefined();
    await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/pages/alpha`)
      .expect(404);

    // A new page is not public until published.
    const gamma = await createPage(owner.token, base, 'gamma', 'Gamma A');
    expect(await publicQuestion(academy.id, 'gamma')).toBeUndefined();
    await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/pages/gamma`)
      .expect(404);
    await api(owner.token).post(`${base}/pages/${gamma}/publish`).expect(201);
    expect(await publicQuestion(academy.id, 'gamma')).toEqual(lt('Gamma A'));

    // Publishing the site makes every remaining draft public.
    await api(owner.token).post(`${base}/publish`).expect(201);
    expect(await publicQuestion(academy.id, 'beta')).toEqual(lt('Beta B'));
    expect((await publicPages(academy.id)).find((p) => p.slug === 'beta')!.title).toBe(
      'beta renamed',
    );
    const live = await publicConfiguration(academy.id);
    expect(live.brand.primaryColor).toBe('20 60% 45%');
    expect(live.seo.siteTitle).toEqual(lt('Site A'));
    managed = await api(owner.token).get(`${base}/configuration`).expect(200);
    expect(managed.body.unpublishedChanges).toEqual({ configuration: false, pages: 0 });

    // The other Academy saw none of it, and cannot publish this one's page.
    expect(await publicQuestion(other.academy.id, 'alpha')).toEqual(lt('Other A'));
    await api(other.owner.token)
      .post(`${otherBase}/pages/${beta}/publish`)
      .expect((res) => expect([403, 404]).toContain(res.status));
    await api(other.owner.token)
      .post(`${base}/pages/${beta}/publish`)
      .expect((res) => expect([403, 404]).toContain(res.status));
    expect(otherPage).toEqual(expect.any(String));
  });

  it('refuses to publish a page onto an address another live page still holds', async () => {
    const { owner, academy } = await seedManagedAcademy('draft-pub-slug');
    const base = `/academies/${academy.id}/website`;
    const first = await createPage(owner.token, base, 'offer', 'First A');
    const second = await createPage(owner.token, base, 'later', 'Second A');
    await api(owner.token).post(`${base}/publish`).expect(201);

    // Draft: `first` moves away from /offer and `second` takes it.
    await editPage(owner.token, base, first, { slug: 'old-offer' });
    await editPage(owner.token, base, second, { slug: 'offer' });

    const refused = await api(owner.token)
      .post(`${base}/pages/${second}/publish`)
      .expect(409);
    expect(refused.body.error.messageKey).toBe('errors.website.publishedSlugTaken');
    expect(refused.body.error.details).toEqual({ pageId: first, title: 'offer title' });
    expect(await publicQuestion(academy.id, 'offer')).toEqual(lt('First A'));
    expect(await publicQuestion(academy.id, 'later')).toEqual(lt('Second A'));

    // Publishing the page that frees the address first, then the other, works.
    await api(owner.token).post(`${base}/pages/${first}/publish`).expect(201);
    await api(owner.token).post(`${base}/pages/${second}/publish`).expect(201);
    const live = await publicPages(academy.id);
    expect(live.filter((p) => p.slug === 'offer').map((p) => p.id)).toEqual([second]);
    expect(await publicQuestion(academy.id, 'old-offer')).toEqual(lt('First A'));
  });

  it('publishes two pages at the same time without losing either', async () => {
    const { owner, academy } = await seedManagedAcademy('draft-pub-race');
    const base = `/academies/${academy.id}/website`;
    const a = await createPage(owner.token, base, 'race-a', 'A1');
    const b = await createPage(owner.token, base, 'race-b', 'B1');
    await api(owner.token).post(`${base}/publish`).expect(201);
    await editPage(owner.token, base, a, { sections: [faqSection('A2')] });
    await editPage(owner.token, base, b, { sections: [faqSection('B2')] });
    const before = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });

    const results = await Promise.all([
      api(owner.token).post(`${base}/pages/${a}/publish`),
      api(owner.token).post(`${base}/pages/${b}/publish`),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const after = await admin.websiteConfiguration.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(after.configVersion).toBe(before.configVersion + 2);
    expect(await publicQuestion(academy.id, 'race-a')).toEqual(lt('A2'));
    expect(await publicQuestion(academy.id, 'race-b')).toEqual(lt('B2'));
  });

  it('refuses a page publish from a non-member and an anonymous caller', async () => {
    const { owner, academy } = await seedManagedAcademy('draft-pub-auth');
    const stranger = await signUpAndSignIn('draft-pub-stranger');
    const base = `/academies/${academy.id}/website`;
    const page = await createPage(owner.token, base, 'only', 'Only A');
    await api(owner.token).post(`${base}/publish`).expect(201);
    await editPage(owner.token, base, page, { sections: [faqSection('Only B')] });

    await request(app.getHttpServer()).post(`${base}/pages/${page}/publish`).expect(401);
    await api(stranger.token)
      .post(`${base}/pages/${page}/publish`)
      .expect((res) => expect([403, 404]).toContain(res.status));
    expect(await publicQuestion(academy.id, 'only')).toEqual(lt('Only A'));
  });
});
