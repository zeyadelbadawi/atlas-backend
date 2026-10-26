/**
 * B3 — blog request validation (the same class-validator rules the global
 * ValidationPipe applies: whitelist + forbidNonWhitelisted).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateBlogPostDto,
  PublicBlogListQueryDto,
  PublishBlogPostDto,
  UpdateBlogPostDto,
} from './blog.dto';

async function errors(cls: new () => object, body: object): Promise<string[]> {
  const result = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flatten = (list: typeof result, prefix = ''): string[] =>
    list.flatMap((error) => [
      ...(error.constraints ? [`${prefix}${error.property}`] : []),
      ...flatten(error.children ?? [], `${prefix}${error.property}.`),
    ]);
  return flatten(result);
}

const valid = { slug: 'protect-your-courses', kind: 'pillar', topic: 'protection' };

describe('CreateBlogPostDto', () => {
  it('accepts a minimal draft', async () => {
    expect(await errors(CreateBlogPostDto, valid)).toEqual([]);
  });

  it.each([
    'ab',
    'Upper-Case',
    'double--dash',
    '-leading',
    'trailing-',
    'under_score',
    'a'.repeat(81),
  ])('refuses the slug %j', async (slug) => {
    expect(await errors(CreateBlogPostDto, { ...valid, slug })).toContain('slug');
  });

  it('refuses an unknown kind, topic or extra field (status is never accepted)', async () => {
    expect(await errors(CreateBlogPostDto, { ...valid, kind: 'essay' })).toContain(
      'kind',
    );
    expect(await errors(CreateBlogPostDto, { ...valid, topic: 'sports' })).toContain(
      'topic',
    );
    expect(await errors(CreateBlogPostDto, { ...valid, status: 'published' })).toContain(
      'status',
    );
  });

  it('cover image URL: https or site-relative only', async () => {
    const cover = (url: string) => ({
      ...valid,
      coverImage: { url, width: 1200, height: 630 },
    });
    expect(await errors(CreateBlogPostDto, cover('https://cdn.example/a.webp'))).toEqual(
      [],
    );
    expect(
      await errors(CreateBlogPostDto, cover('/marketing-assets/blog/a.webp')),
    ).toEqual([]);
    for (const bad of [
      'javascript:alert(1)',
      'data:image/png;base64,AA',
      'http://cdn.example/a.png',
      '//cdn.example/a',
    ]) {
      expect(await errors(CreateBlogPostDto, cover(bad))).toContain('coverImage.url');
    }
    expect(
      await errors(CreateBlogPostDto, {
        ...valid,
        coverImage: { url: '/a.webp', width: 0, height: 1 },
      }),
    ).toContain('coverImage.width');
  });

  it('related posts: at most 3 unique UUIDs', async () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ];
    expect(
      await errors(CreateBlogPostDto, { ...valid, relatedPostIds: ids.slice(0, 3) }),
    ).toEqual([]);
    expect(await errors(CreateBlogPostDto, { ...valid, relatedPostIds: ids })).toContain(
      'relatedPostIds',
    );
    expect(
      await errors(CreateBlogPostDto, { ...valid, relatedPostIds: [ids[0], ids[0]] }),
    ).toContain('relatedPostIds');
    expect(
      await errors(CreateBlogPostDto, { ...valid, relatedPostIds: ['nope'] }),
    ).toContain('relatedPostIds');
  });

  it('enforces the maximum lengths of each language', async () => {
    const t = (en: object) => ({ ...valid, translations: { en } });
    expect(await errors(CreateBlogPostDto, t({ title: 'x'.repeat(141) }))).toContain(
      'translations.en.title',
    );
    expect(await errors(CreateBlogPostDto, t({ excerpt: 'x'.repeat(301) }))).toContain(
      'translations.en.excerpt',
    );
    expect(await errors(CreateBlogPostDto, t({ body: 'x'.repeat(60_001) }))).toContain(
      'translations.en.body',
    );
    expect(await errors(CreateBlogPostDto, t({ coverAlt: 'x'.repeat(201) }))).toContain(
      'translations.en.coverAlt',
    );
    expect(await errors(CreateBlogPostDto, t({ seoTitle: 'x'.repeat(71) }))).toContain(
      'translations.en.seoTitle',
    );
    expect(
      await errors(CreateBlogPostDto, t({ seoDescription: 'x'.repeat(171) })),
    ).toContain('translations.en.seoDescription');
    expect(await errors(CreateBlogPostDto, t({ body: 'x'.repeat(60_000) }))).toEqual([]);
    expect(
      await errors(CreateBlogPostDto, { ...valid, translations: { fr: {} } }),
    ).toContain('translations.fr');
  });

  it('author name 1..80 after trimming', async () => {
    expect(await errors(CreateBlogPostDto, { ...valid, authorName: '   ' })).toContain(
      'authorName',
    );
    expect(
      await errors(CreateBlogPostDto, { ...valid, authorName: 'x'.repeat(81) }),
    ).toContain('authorName');
  });
});

describe('UpdateBlogPostDto / PublishBlogPostDto', () => {
  it('requires the version it read', async () => {
    expect(await errors(UpdateBlogPostDto, { featured: true })).toContain('version');
    expect(await errors(UpdateBlogPostDto, { version: 0 })).toContain('version');
    expect(
      await errors(UpdateBlogPostDto, { version: 3, translations: { ar: null } }),
    ).toEqual([]);
  });

  it('publishAt must be a strict ISO timestamp', async () => {
    expect(await errors(PublishBlogPostDto, { version: 1 })).toEqual([]);
    expect(
      await errors(PublishBlogPostDto, { version: 1, publishAt: '2026-11-02T08:00:00Z' }),
    ).toEqual([]);
    expect(
      await errors(PublishBlogPostDto, { version: 1, publishAt: 'tomorrow' }),
    ).toContain('publishAt');
  });
});

describe('PublicBlogListQueryDto', () => {
  it('page size is at most 24 and the locale en|ar', async () => {
    expect(
      await errors(PublicBlogListQueryDto, { pageSize: '24', locale: 'ar' }),
    ).toEqual([]);
    expect(await errors(PublicBlogListQueryDto, { pageSize: '25' })).toContain(
      'pageSize',
    );
    expect(await errors(PublicBlogListQueryDto, { locale: 'fr' })).toContain('locale');
    expect(await errors(PublicBlogListQueryDto, { status: 'draft' })).toContain('status');
  });
});
