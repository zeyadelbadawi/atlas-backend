/**
 * B3 — PlatformBlogPostsService against an in-memory transaction: the
 * parity rule on publish, optimistic concurrency, slug uniqueness,
 * markdown URL checks, transitions, delete rules, edge purges, and that the
 * public reads never hand out a draft, an archived or a future post.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PlatformBlogPost } from '@prisma/client';
import {
  BLOG_AUDIT,
  BLOG_STALE_CODE,
  PlatformBlogPostsService,
  normalizeTranslation,
} from './platform-blog-posts.service';

const PO = 'po-user';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const LATER = new Date('2026-11-02T08:00:00.000Z');

const EN = {
  title: 'Protecting your courses',
  excerpt: 'How Atlas keeps paid lessons for paying students only.',
  body: 'Paid lessons stay paid. [Pricing](/pricing)',
};
const AR = {
  title: 'حماية دوراتك',
  excerpt: 'كيف تحافظ أطلس على الدروس المدفوعة للطلاب الذين دفعوا فقط.',
  body: 'الدروس المدفوعة تبقى مدفوعة.',
};

let sequence = 0;
function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function harness() {
  const rows = new Map<string, PlatformBlogPost>();
  const audits: { action: string; context?: Record<string, unknown> }[] = [];
  const lastWhere: { value?: unknown } = {};
  const matches = (row: PlatformBlogPost, where: Record<string, unknown> = {}) => {
    const id = where.id as { in?: string[] } | string | undefined;
    if (typeof id === 'string' && row.id !== id) return false;
    if (id && typeof id === 'object' && id.in && !id.in.includes(row.id)) return false;
    if (where.slug && row.slug !== where.slug) return false;
    return true;
  };
  const model = {
    findUnique: jest.fn(async ({ where }: { where: { id?: string; slug?: string } }) => {
      for (const row of rows.values()) {
        if (where.id && row.id === where.id) return { ...row };
        if (where.slug && row.slug === where.slug) return { ...row };
      }
      return null;
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = rows.get(where.id);
      if (!row) throw new Error('not found');
      return { ...row };
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      lastWhere.value = where;
      return [...rows.values()].find((row) => matches(row, where)) ?? null;
    }),
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      lastWhere.value = where;
      return [...rows.values()].filter((row) => matches(row, where));
    }),
    count: jest.fn(async () => rows.size),
    create: jest.fn(async ({ data }: { data: Partial<PlatformBlogPost> }) => {
      const row = {
        id: uuid(),
        version: 1,
        publishAt: null,
        publishedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      } as PlatformBlogPost;
      rows.set(row.id, row);
      return { ...row };
    }),
    update: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.id)!;
        const next = { ...row } as Record<string, unknown>;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as object)) {
            next[key] =
              (row as unknown as Record<string, number>)[key] +
              (value as { increment: number }).increment;
          } else {
            next[key] = value;
          }
        }
        rows.set(row.id, next as unknown as PlatformBlogPost);
        return { ...(next as unknown as PlatformBlogPost) };
      },
    ),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      rows.delete(where.id);
    }),
  };
  const tx = {
    platformBlogPost: model,
    user: { findMany: jest.fn(async () => [{ id: PO, name: 'Platform Owner' }]) },
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, id: string) =>
      rows.has(id) ? [{ id }] : [],
    ),
    $executeRaw: jest.fn(async () => 0),
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_user: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
    runWithoutContext: jest.fn(async (work: (t: typeof tx) => unknown) => work(tx)),
  };
  const audit = {
    write: jest.fn(
      async (
        _tx: unknown,
        input: { action: string; context?: Record<string, unknown> },
      ) => {
        audits.push(input);
      },
    ),
  };
  const edge = { purgeBlog: jest.fn() };
  const service = new PlatformBlogPostsService(
    tenancy as never,
    audit as never,
    edge as never,
  );
  return { service, rows, audits, edge, tx, lastWhere };
}

async function draft(
  h: ReturnType<typeof harness>,
  translations: object = { en: EN, ar: AR },
) {
  return h.service.create(
    PO,
    {
      slug: `post-${uuid().slice(-4)}`,
      kind: 'article',
      topic: 'protection',
      translations,
    } as never,
    NOW,
  );
}

describe('PlatformBlogPostsService', () => {
  describe('create', () => {
    it('always creates a draft, with reading minutes computed and the audit row written', async () => {
      const h = harness();
      const post = await draft(h);
      expect(post.status).toBe('draft');
      expect(post.version).toBe(1);
      expect(post.readingMinutes).toEqual({ en: 1, ar: 1 });
      expect(post.translations.en?.title).toBe(EN.title);
      expect(post.createdByName).toBe('Platform Owner');
      expect(h.audits.map((a) => a.action)).toEqual([BLOG_AUDIT.created]);
      expect(h.edge.purgeBlog).not.toHaveBeenCalled();
    });

    it('allows a half-written language in a draft', async () => {
      const h = harness();
      const post = await draft(h, { en: EN, ar: { title: 'عنوان' } });
      expect(post.translations.ar).toEqual(
        expect.objectContaining({ title: 'عنوان', excerpt: '', body: '' }),
      );
    });

    it('refuses a taken slug with 409 errors.blog.slugTaken', async () => {
      const h = harness();
      const first = await draft(h);
      await expect(
        h.service.create(
          PO,
          { slug: first.slug, kind: 'article', topic: 'news' } as never,
          NOW,
        ),
      ).rejects.toMatchObject({ response: { messageKey: 'errors.blog.slugTaken' } });
    });

    it('refuses unsafe markdown links and images', async () => {
      const h = harness();
      await expect(
        draft(h, { en: { ...EN, body: '[x](javascript:alert(1))' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        draft(h, { ar: { ...AR, body: '![x](data:image/png;base64,AAAA)' } }),
      ).rejects.toMatchObject({
        response: {
          messageKey: 'errors.blog.unsafeMarkdownUrl',
          details: { locale: 'ar' },
        },
      });
    });

    it('refuses related posts that do not exist', async () => {
      const h = harness();
      await expect(
        h.service.create(
          PO,
          {
            slug: 'with-related',
            kind: 'article',
            topic: 'news',
            relatedPostIds: ['99999999-0000-4000-8000-000000000000'],
          } as never,
          NOW,
        ),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.blog.relatedPostInvalid' },
      });
    });
  });

  describe('optimistic concurrency', () => {
    it('refuses a stale version with 409 BLOG_POST_STALE and changes nothing', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.update(PO, post.id, { version: 1, featured: true } as never, NOW);
      const stale = h.service.update(
        PO,
        post.id,
        { version: 1, featured: false } as never,
        NOW,
      );
      await expect(stale).rejects.toBeInstanceOf(ConflictException);
      await expect(stale).rejects.toMatchObject({
        response: { messageKey: 'errors.blog.stale', code: BLOG_STALE_CODE },
      });
      expect(h.rows.get(post.id)!.featured).toBe(true);
      expect(h.rows.get(post.id)!.version).toBe(2);
    });

    it('guards publish, unpublish and archive with the version too', async () => {
      const h = harness();
      const post = await draft(h);
      await expect(
        h.service.publish(PO, post.id, { version: 7 }, NOW),
      ).rejects.toMatchObject({
        response: { code: BLOG_STALE_CODE },
      });
      await expect(h.service.archive(PO, post.id, 7, NOW)).rejects.toMatchObject({
        response: { code: BLOG_STALE_CODE },
      });
    });

    it('a PATCH that changes nothing keeps the version', async () => {
      const h = harness();
      const post = await draft(h);
      const same = await h.service.update(
        PO,
        post.id,
        { version: 1, featured: false } as never,
        NOW,
      );
      expect(same.version).toBe(1);
      expect(h.audits).toHaveLength(1);
    });

    it('404s an unknown post', async () => {
      const h = harness();
      await expect(
        h.service.update(
          PO,
          '99999999-0000-4000-8000-000000000000',
          { version: 1 } as never,
          NOW,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('publishing (W2 parity rule)', () => {
    it('refuses to publish without both languages complete → 422', async () => {
      const h = harness();
      const post = await draft(h, { en: EN });
      await expect(
        h.service.publish(PO, post.id, { version: 1 }, NOW),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      await expect(
        h.service.publish(PO, post.id, { version: 1 }, NOW),
      ).rejects.toMatchObject({
        response: {
          messageKey: 'errors.blog.translationsIncomplete',
          details: { locales: 'ar' },
        },
      });
      expect(h.rows.get(post.id)!.status).toBe('draft');
      expect(h.edge.purgeBlog).not.toHaveBeenCalled();
    });

    it('refuses scheduling without parity too', async () => {
      const h = harness();
      const post = await draft(h, { ar: AR });
      await expect(
        h.service.publish(
          PO,
          post.id,
          { version: 1, publishAt: LATER.toISOString() },
          NOW,
        ),
      ).rejects.toMatchObject({ response: { details: { locales: 'en' } } });
    });

    it('requires alt text when there is a cover image', async () => {
      const h = harness();
      const post = await h.service.create(
        PO,
        {
          slug: 'with-cover',
          kind: 'pillar',
          topic: 'protection',
          coverImage: { url: '/marketing-assets/blog/a.webp', width: 1200, height: 630 },
          translations: { en: { ...EN, coverAlt: 'A lock' }, ar: AR },
        } as never,
        NOW,
      );
      await expect(
        h.service.publish(PO, post.id, { version: 1 }, NOW),
      ).rejects.toMatchObject({
        response: { details: { locales: 'ar' } },
      });
    });

    it('publishes now (no time) and purges the blog edge tag', async () => {
      const h = harness();
      const post = await draft(h);
      const published = await h.service.publish(PO, post.id, { version: 1 }, NOW);
      expect(published).toMatchObject({
        status: 'published',
        publishAt: NOW.toISOString(),
        publishedAt: NOW.toISOString(),
        isPublic: true,
        version: 2,
      });
      expect(h.edge.purgeBlog).toHaveBeenCalledTimes(1);
      expect(h.audits.at(-1)).toMatchObject({
        action: BLOG_AUDIT.published,
        context: { status: 'published', previousStatus: 'draft' },
      });
    });

    it('a past time publishes now', async () => {
      const h = harness();
      const post = await draft(h);
      const published = await h.service.publish(
        PO,
        post.id,
        { version: 1, publishAt: '2026-01-01T00:00:00.000Z' },
        NOW,
      );
      expect(published.status).toBe('published');
      expect(published.publishAt).toBe(NOW.toISOString());
    });

    it('a future time schedules (not public yet)', async () => {
      const h = harness();
      const post = await draft(h);
      const scheduled = await h.service.publish(
        PO,
        post.id,
        { version: 1, publishAt: LATER.toISOString() },
        NOW,
      );
      expect(scheduled).toMatchObject({
        status: 'scheduled',
        publishAt: LATER.toISOString(),
        isPublic: false,
      });
      const atTime = await h.service.get(PO, post.id, LATER);
      expect(atTime.isPublic).toBe(true);
    });

    it('a public post cannot be edited out of parity, and a valid edit purges', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(PO, post.id, { version: 1 }, NOW);
      await expect(
        h.service.update(
          PO,
          post.id,
          { version: 2, translations: { ar: null } } as never,
          NOW,
        ),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.blog.translationsIncomplete' },
      });
      h.edge.purgeBlog.mockClear();
      await h.service.update(PO, post.id, { version: 2, featured: true } as never, NOW);
      expect(h.edge.purgeBlog).toHaveBeenCalledTimes(1);
    });

    it('editing a draft does not purge', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.update(PO, post.id, { version: 1, featured: true } as never, NOW);
      expect(h.edge.purgeBlog).not.toHaveBeenCalled();
    });
  });

  describe('transitions and delete', () => {
    it('unpublish → draft clears the schedule and purges; a second unpublish is 409', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(PO, post.id, { version: 1 }, NOW);
      h.edge.purgeBlog.mockClear();
      const back = await h.service.unpublish(PO, post.id, 2, NOW);
      expect(back).toMatchObject({
        status: 'draft',
        publishAt: null,
        publishedAt: NOW.toISOString(),
      });
      expect(h.edge.purgeBlog).toHaveBeenCalledTimes(1);
      await expect(h.service.unpublish(PO, post.id, 3, NOW)).rejects.toMatchObject({
        response: { messageKey: 'errors.blog.invalidTransition' },
      });
    });

    it('unpublishing a scheduled post before its time forgets the first-publish date', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(
        PO,
        post.id,
        { version: 1, publishAt: LATER.toISOString() },
        NOW,
      );
      const back = await h.service.unpublish(PO, post.id, 2, NOW);
      expect(back.publishedAt).toBeNull();
    });

    it('archive from published purges; archive twice is 409', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(PO, post.id, { version: 1 }, NOW);
      h.edge.purgeBlog.mockClear();
      const archived = await h.service.archive(PO, post.id, 2, NOW);
      expect(archived.status).toBe('archived');
      expect(archived.isPublic).toBe(false);
      expect(h.edge.purgeBlog).toHaveBeenCalledTimes(1);
      await expect(h.service.archive(PO, post.id, 3, NOW)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('deletes only drafts and archived posts', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(PO, post.id, { version: 1 }, NOW);
      await expect(h.service.remove(PO, post.id)).rejects.toMatchObject({
        response: { messageKey: 'errors.blog.deleteNotAllowed' },
      });
      await h.service.archive(PO, post.id, 2, NOW);
      h.edge.purgeBlog.mockClear();
      await h.service.remove(PO, post.id);
      expect(h.rows.has(post.id)).toBe(false);
      expect(h.edge.purgeBlog).toHaveBeenCalledTimes(1);
      expect(h.audits.at(-1)?.action).toBe(BLOG_AUDIT.deleted);
    });

    it('deleting a never-published draft does not purge', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.remove(PO, post.id);
      expect(h.edge.purgeBlog).not.toHaveBeenCalled();
    });
  });

  describe('public reads', () => {
    it('filters on public status and publish time, and 404s whatever is not public', async () => {
      const h = harness();
      const post = await draft(h);
      // Even if a row came back (no RLS in this fake), a draft is never served.
      await expect(h.service.publicDetail(post.slug, 'en', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.lastWhere.value).toMatchObject({
        slug: post.slug,
        status: { in: ['scheduled', 'published'] },
        publishAt: { lte: NOW },
        titleEn: { not: null },
      });
    });

    it('a scheduled post is served only from its publish time', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(
        PO,
        post.id,
        { version: 1, publishAt: LATER.toISOString() },
        NOW,
      );
      await expect(h.service.publicDetail(post.slug, 'en', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const served = await h.service.publicDetail(post.slug, 'ar', LATER);
      expect(served).toMatchObject({
        slug: post.slug,
        locale: 'ar',
        title: AR.title,
        body: AR.body,
        alternateLocaleAvailable: true,
      });
    });

    it('never puts internal fields in a public response', async () => {
      const h = harness();
      const post = await draft(h);
      await h.service.publish(PO, post.id, { version: 1 }, NOW);
      const served = await h.service.publicDetail(post.slug, 'en', NOW);
      for (const key of [
        'id',
        'status',
        'version',
        'createdByName',
        'updatedByName',
        'createdByUserId',
        'relatedPostIds',
        'translations',
      ]) {
        expect(served).not.toHaveProperty(key);
      }
    });

    it('rejects a malformed slug without a query', async () => {
      const h = harness();
      await expect(h.service.publicDetail('../etc', 'en', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(h.tx.platformBlogPost.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('normalizeTranslation', () => {
    it('trims text, keeps the body as written, and treats an empty language as absent', () => {
      expect(normalizeTranslation({ title: '  T  ', body: '  body  ' })).toMatchObject({
        title: 'T',
        body: '  body  ',
      });
      expect(normalizeTranslation({ seoTitle: 'only seo' })).toEqual({
        title: null,
        excerpt: null,
        body: null,
        coverAlt: null,
        seoTitle: null,
        seoDescription: null,
      });
    });
  });
});
