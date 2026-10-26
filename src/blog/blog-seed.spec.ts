/**
 * B3 — the blog seed file: the API's own validation applied to every entry
 * before anything is written.
 */
import { BlogSeedError, parseBlogSeed } from './blog-seed';

const en = {
  title: 'Protecting your courses',
  excerpt: 'How Atlas keeps paid lessons for paying students only.',
  body: 'Body. [Pricing](/pricing)',
};
const ar = {
  title: 'حماية دوراتك',
  excerpt: 'كيف تحافظ أطلس على الدروس المدفوعة للطلاب الذين دفعوا فقط.',
  body: 'نص المقال.',
};
const post = (overrides: object = {}) => ({
  slug: 'protect-your-courses',
  kind: 'pillar',
  topic: 'protection',
  status: 'published',
  translations: { en, ar },
  ...overrides,
});

describe('parseBlogSeed', () => {
  it('accepts an array or { posts }', () => {
    expect(parseBlogSeed([post()])).toHaveLength(1);
    const [entry] = parseBlogSeed({
      posts: [post({ publishAt: '2026-10-20T08:00:00Z', relatedSlugs: ['other-post'] })],
    });
    expect(entry).toMatchObject({ status: 'published', relatedSlugs: ['other-post'] });
    expect(entry.publishAt?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('refuses a public post without both languages (parity)', () => {
    expect(() => parseBlogSeed([post({ translations: { en } })])).toThrow(
      /incomplete translations for ar/,
    );
    expect(parseBlogSeed([post({ status: 'draft', translations: { en } })])).toHaveLength(
      1,
    );
  });

  it('lists every problem at once', () => {
    let message = '';
    try {
      parseBlogSeed([
        post({ slug: 'Bad Slug' }),
        post({ slug: 'dup' }),
        post({
          slug: 'dup',
          translations: { en: { ...en, body: '[x](javascript:alert(1))' }, ar },
        }),
        post({ slug: 'self', relatedSlugs: ['self'] }),
        post({
          slug: 'cover',
          coverImage: { url: 'http://x.example/a.png', width: 1, height: 1 },
        }),
        post({ slug: 'state', status: 'archived' }),
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(BlogSeedError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/Bad Slug/);
    expect(message).toMatch(/duplicate slug/);
    expect(message).toMatch(/unsafe link URL in en body/);
    expect(message).toMatch(/relates to itself/);
    expect(message).toMatch(/coverImage/);
    expect(message).toMatch(/status must be draft, scheduled or published/);
  });

  it('refuses a file that is not a list', () => {
    expect(() => parseBlogSeed({ nope: true })).toThrow(BlogSeedError);
  });
});
