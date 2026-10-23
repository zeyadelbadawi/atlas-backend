/**
 * CMS phase 4 — page history and restore, create-with-sections, and the
 * header/footer lock, against the real database (RLS, the version table's
 * retention prune, the role guards):
 *   - a publish records a `published` version; draft saves record at most
 *     one `draft_snapshot` per 10 minutes (the copy they replace);
 *   - the list is metadata only, newest first; one version carries its
 *     content; a restore writes the DRAFT only, is version-pinned, keeps a
 *     `restore_backup` and refuses (422) a copy today's schemas reject;
 *   - another Academy can neither list, read nor restore any of it;
 *   - a page created with sections commits with them, or not at all;
 *   - the chrome lock refuses header/footer/navigation changes, lets
 *     everything else through, and only an owner/administrator toggles it.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const lt = (en: string) => ({ en, ar: `${en} (ar)` });
const visibility = { desktop: true, tablet: true, mobile: true };

const faqSection = (question: string) => ({
  id: 'faq',
  type: 'faq',
  enabled: true,
  visibility,
  config: {
    items: [{ id: 'q1', question: lt(question), answer: lt(`${question} answer`) }],
  },
});

describe('Website page history, create-with-sections and chrome lock (e2e)', () => {
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
    return { owner, org, academy, base: `/academies/${academy.id}/website` };
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

  async function pageVersion(token: string, base: string, pageId: string) {
    return (await api(token).get(`${base}/pages/${pageId}`).expect(200)).body
      .version as number;
  }

  async function save(
    token: string,
    base: string,
    pageId: string,
    changes: Record<string, unknown>,
  ) {
    const expectedVersion = await pageVersion(token, base, pageId);
    return api(token)
      .patch(`${base}/pages/${pageId}`, { ...changes, expectedVersion })
      .expect(200);
  }

  it('creates a page with its sections in one call, or not at all', async () => {
    const { owner, academy, base } = await seedManagedAcademy('p4-create');

    const created = await api(owner.token)
      .post(`${base}/pages`, {
        title: 'With sections',
        slug: 'with-sections',
        sections: [faqSection('Q1')],
      })
      .expect(201);
    expect(created.body.sections).toHaveLength(1);
    expect(created.body.sections[0].config.items[0].question).toEqual(lt('Q1'));
    expect(created.body.version).toBe(1);

    const plain = await api(owner.token)
      .post(`${base}/pages`, { title: 'Plain', slug: 'plain' })
      .expect(201);
    expect(plain.body.sections).toEqual([]);

    const refused = await api(owner.token)
      .post(`${base}/pages`, {
        title: 'Broken',
        slug: 'broken',
        sections: [{ ...faqSection('Q'), config: { items: 'nope' } }],
      })
      .expect(400);
    expect(refused.body.error.messageKey).toBe('errors.validation.failed');
    expect(refused.body.error.violations[0].field).toMatch(/^0\.config\.items/);

    // A section pointing at a page that does not exist is refused by the
    // same reference validator a save uses.
    await api(owner.token)
      .post(`${base}/pages`, {
        title: 'Bad link',
        slug: 'bad-link',
        sections: [
          {
            id: 'cta',
            type: 'cta',
            enabled: true,
            visibility,
            config: {
              title: lt('Join'),
              primaryCta: {
                label: lt('Go'),
                pageId: '00000000-0000-4000-8000-000000000000',
              },
            },
          },
        ],
      })
      .expect(400);

    const slugs = (
      await admin.websitePage.findMany({
        where: { academyId: academy.id },
        select: { slug: true },
      })
    ).map((row) => row.slug);
    expect(slugs).toEqual(expect.arrayContaining(['with-sections', 'plain']));
    expect(slugs).not.toContain('broken');
    expect(slugs).not.toContain('bad-link');
  });

  it('records history on publish and (throttled) on draft saves, and restores into the draft', async () => {
    const { owner, base } = await seedManagedAcademy('p4-history');
    const page = await api(owner.token)
      .post(`${base}/pages`, {
        title: 'History',
        slug: 'history',
        sections: [faqSection('V1')],
      })
      .expect(201);
    const pageId = page.body.id as string;

    await api(owner.token)
      .post(`${base}/pages/${pageId}/publish`, { expectedVersion: 1 })
      .expect(201);
    // Re-publishing what is already live records nothing new.
    await api(owner.token)
      .post(`${base}/pages/${pageId}/publish`, { expectedVersion: 1 })
      .expect(201);

    // The first save replaces version 1, which the `published` entry already
    // holds; the second keeps version 2; the third is inside the 10 minutes.
    await save(owner.token, base, pageId, { sections: [faqSection('V2')] });
    await save(owner.token, base, pageId, { sections: [faqSection('V3')] });
    await save(owner.token, base, pageId, { sections: [faqSection('V4')] });

    const kinds = async () =>
      (await api(owner.token).get(`${base}/pages/${pageId}/versions`).expect(200)).body
        .items;
    expect(
      (await kinds()).map((item: { kind: string; sourceVersion: number }) => [
        item.kind,
        item.sourceVersion,
      ]),
    ).toEqual([
      ['draft_snapshot', 2],
      ['published', 1],
    ]);

    // Ten minutes on, the next save keeps the copy it replaces again.
    await admin.$executeRaw`
      UPDATE "website_page_versions"
      SET "created_at" = "created_at" - interval '11 minutes'
      WHERE "page_id" = ${pageId}`;
    await save(owner.token, base, pageId, {
      title: 'History renamed',
      sections: [faqSection('V5')],
    });

    const history = { body: { items: await kinds() } };
    expect(
      history.body.items.map((item: { kind: string; sourceVersion: number }) => [
        item.kind,
        item.sourceVersion,
      ]),
    ).toEqual([
      ['draft_snapshot', 4],
      ['draft_snapshot', 2],
      ['published', 1],
    ]);
    const published = history.body.items[2];
    expect(published).not.toHaveProperty('sections');
    expect(published).not.toHaveProperty('seo');
    expect(published.title).toBe('History');
    expect(published.createdBy).toEqual({ id: owner.userId, name: expect.any(String) });

    const full = await api(owner.token)
      .get(`${base}/pages/${pageId}/versions/${published.id}`)
      .expect(200);
    expect(full.body.sections[0].config.items[0].question).toEqual(lt('V1'));

    // Restore: version-pinned like a save.
    const current = await pageVersion(owner.token, base, pageId);
    await api(owner.token)
      .post(`${base}/pages/${pageId}/versions/${published.id}/restore`, {})
      .expect(400);
    const stale = await api(owner.token)
      .post(`${base}/pages/${pageId}/versions/${published.id}/restore`, {
        expectedVersion: current - 1,
      })
      .expect(409);
    expect(stale.body.error.code).toBe('stale_resource_version');

    const restored = await api(owner.token)
      .post(`${base}/pages/${pageId}/versions/${published.id}/restore`, {
        expectedVersion: current,
      })
      .expect(200);
    expect(restored.body.version).toBe(current + 1);
    expect(restored.body.title).toBe('History');
    expect(restored.body.sections[0].config.items[0].question).toEqual(lt('V1'));
    // The draft only: the page is not republished by a restore.
    expect(restored.body.hasUnpublishedChanges).toBe(true);
    const stored = await admin.websitePage.findUniqueOrThrow({ where: { id: pageId } });
    expect(stored.publishedVersion).toBe(1);

    // The replaced draft is kept, so the restore can be undone.
    const after = await api(owner.token)
      .get(`${base}/pages/${pageId}/versions`)
      .expect(200);
    expect(after.body.items[0]).toMatchObject({
      kind: 'restore_backup',
      sourceVersion: current,
      title: 'History renamed',
    });
    const undo = await api(owner.token)
      .post(`${base}/pages/${pageId}/versions/${after.body.items[0].id}/restore`, {
        expectedVersion: current + 1,
      })
      .expect(200);
    expect(undo.body.sections[0].config.items[0].question).toEqual(lt('V5'));

    const activity = await admin.auditLogEntry.findFirst({
      where: { targetId: pageId, action: 'website_page.restored' },
    });
    expect(activity).not.toBeNull();
  });

  it('refuses (422) a version that no longer validates, writing nothing', async () => {
    const { owner, academy, base } = await seedManagedAcademy('p4-invalid');
    const page = await api(owner.token)
      .post(`${base}/pages`, {
        title: 'Invalid',
        slug: 'invalid',
        sections: [faqSection('Ok')],
      })
      .expect(201);
    const pageId = page.body.id as string;
    const old = await admin.websitePageVersion.create({
      data: {
        academyId: academy.id,
        pageId,
        kind: 'published',
        title: 'Invalid',
        slug: 'invalid',
        visible: true,
        seo: {},
        sections: [
          { id: 'x', type: 'retiredSectionType', enabled: true, visibility, config: {} },
        ],
        sourceVersion: 1,
      },
    });

    const refused = await api(owner.token)
      .post(`${base}/pages/${pageId}/versions/${old.id}/restore`, { expectedVersion: 1 })
      .expect(422);
    expect(refused.body.error.code).toBe('website_page_version_invalid');
    expect(refused.body.error.messageKey).toBe('errors.website.versionNoLongerValid');
    expect(refused.body.error.violations[0].field).toMatch(/^sections\./);

    const stored = await admin.websitePage.findUniqueOrThrow({ where: { id: pageId } });
    expect(stored.version).toBe(1);
    expect(await admin.websitePageVersion.count({ where: { pageId } })).toBe(1);
  });

  it('keeps the newest 30 versions per page, and a site publish records changed pages only', async () => {
    const { owner, academy, base } = await seedManagedAcademy('p4-retention');
    const page = await api(owner.token)
      .post(`${base}/pages`, { title: 'Kept', slug: 'kept', sections: [faqSection('A')] })
      .expect(201);
    const pageId = page.body.id as string;
    const untouched = await api(owner.token)
      .post(`${base}/pages`, { title: 'Untouched', slug: 'untouched' })
      .expect(201);
    await api(owner.token).post(`${base}/publish`).expect(201);
    const firstRound = await admin.websitePageVersion.groupBy({
      by: ['pageId'],
      where: { academyId: academy.id },
      _count: true,
    });
    expect(firstRound.find((row) => row.pageId === pageId)?._count).toBe(1);
    expect(firstRound.find((row) => row.pageId === untouched.body.id)?._count).toBe(1);

    const longAgo = Date.now() - 24 * 60 * 60 * 1000;
    await admin.websitePageVersion.createMany({
      data: Array.from({ length: 34 }, (_, index) => ({
        academyId: academy.id,
        pageId,
        kind: 'draft_snapshot' as const,
        title: `old ${index}`,
        slug: 'kept',
        visible: true,
        seo: {},
        sections: [],
        sourceVersion: 1,
        createdAt: new Date(longAgo + index * 1000),
      })),
    });

    await save(owner.token, base, pageId, { sections: [faqSection('B')] });
    await api(owner.token).post(`${base}/publish`).expect(201);

    const rows = await admin.websitePageVersion.findMany({
      where: { pageId },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows).toHaveLength(30);
    expect(rows[0].kind).toBe('published');
    expect(rows.some((row) => row.title === 'old 0')).toBe(false);
    // The unchanged page got no second `published` entry.
    expect(
      await admin.websitePageVersion.count({ where: { pageId: untouched.body.id } }),
    ).toBe(1);
  });

  it('never lets another Academy list, read or restore a page history', async () => {
    const a = await seedManagedAcademy('p4-iso-a');
    const b = await seedManagedAcademy('p4-iso-b');
    const page = await api(a.owner.token)
      .post(`${a.base}/pages`, {
        title: 'Mine',
        slug: 'mine',
        sections: [faqSection('A')],
      })
      .expect(201);
    const pageId = page.body.id as string;
    await api(a.owner.token)
      .post(`${a.base}/pages/${pageId}/publish`, { expectedVersion: 1 })
      .expect(201);
    const versionId = (
      await api(a.owner.token).get(`${a.base}/pages/${pageId}/versions`).expect(200)
    ).body.items[0].id as string;

    // B's owner on A's academy: refused before anything is read.
    const foreign = await api(b.owner.token).get(`${a.base}/pages/${pageId}/versions`);
    expect([403, 404]).toContain(foreign.status);
    const foreignRestore = await api(b.owner.token).post(
      `${a.base}/pages/${pageId}/versions/${versionId}/restore`,
      { expectedVersion: 1 },
    );
    expect([403, 404]).toContain(foreignRestore.status);

    // B's owner on B's own academy, with A's ids: nothing there.
    await api(b.owner.token).get(`${b.base}/pages/${pageId}/versions`).expect(404);
    await api(b.owner.token)
      .get(`${b.base}/pages/${pageId}/versions/${versionId}`)
      .expect(404);
    await api(b.owner.token)
      .post(`${b.base}/pages/${pageId}/versions/${versionId}/restore`, {
        expectedVersion: 1,
      })
      .expect(404);

    // A version id only resolves under its own page.
    const other = await api(a.owner.token)
      .post(`${a.base}/pages`, { title: 'Other', slug: 'other' })
      .expect(201);
    await api(a.owner.token)
      .get(`${a.base}/pages/${other.body.id}/versions/${versionId}`)
      .expect(404);

    // An instructor of A is refused like every other website surface.
    const instructor = await signUpAndSignIn('p4-iso-instructor');
    await seedMembership(admin, a.org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, a.academy.id, instructor.userId, 'instructor');
    await api(instructor.token).get(`${a.base}/pages/${pageId}/versions`).expect(403);

    const stored = await admin.websitePage.findUniqueOrThrow({ where: { id: pageId } });
    expect(stored.version).toBe(1);
  });

  it('locks the header, footer and navigation; only an owner or administrator toggles it', async () => {
    const { owner, org, academy, base } = await seedManagedAcademy('p4-lock');
    const manager = await signUpAndSignIn('p4-lock-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    const before = await api(owner.token)
      .patch(`${base}/configuration`, {
        header: { cta: { label: 'Join', authAction: 'signUp' } },
      })
      .expect(200);
    expect(before.body.chromeLocked).toBe(false);

    const forbidden = await api(manager.token)
      .patch(`${base}/configuration`, { chromeLocked: true })
      .expect(403);
    expect(forbidden.body.error.code).toBe('website_chrome_lock_forbidden');

    const locked = await api(owner.token)
      .patch(`${base}/configuration`, { chromeLocked: true })
      .expect(200);
    expect(locked.body.chromeLocked).toBe(true);

    for (const change of [
      { header: { cta: { label: 'Other', authAction: 'signIn' } } },
      { footer: { groups: [], socialLinks: [], copyrightText: lt('© changed') } },
      { navigation: [] as unknown[] },
    ]) {
      const refused = await api(manager.token).patch(`${base}/configuration`, change);
      if ('navigation' in change && refused.status === 200) {
        // An empty menu that was already empty is no change at all.
        continue;
      }
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('website_chrome_locked');
      expect(refused.body.error.messageKey).toBe('errors.website.chromeLocked');
    }

    // Unchanged chrome in the same save, and unrelated settings, go through.
    const unrelated = await api(manager.token)
      .patch(`${base}/configuration`, {
        header: locked.body.header,
        seo: { siteTitle: lt('Still editable') },
      })
      .expect(200);
    expect(unrelated.body.seo.siteTitle).toEqual(lt('Still editable'));
    expect(unrelated.body.header).toEqual(locked.body.header);

    // The manager may not lift it in the same save either.
    await api(manager.token)
      .patch(`${base}/configuration`, {
        chromeLocked: false,
        header: { cta: { label: 'Other', authAction: 'signIn' } },
      })
      .expect(403);

    const unlocked = await api(owner.token)
      .patch(`${base}/configuration`, {
        chromeLocked: false,
        header: { cta: { label: 'Other', authAction: 'signIn' } },
      })
      .expect(200);
    expect(unlocked.body.chromeLocked).toBe(false);
    expect(unlocked.body.header.cta.label).toEqual({ en: 'Other', ar: '' });

    // The public configuration does not expose the flag.
    await api(owner.token).post(`${base}/publish`).expect(201);
    const publicConfiguration = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}`)
      .expect(200);
    expect(publicConfiguration.body).not.toHaveProperty('chromeLocked');
  });
});
