/**
 * B3 — the marketing blog's pure rules: visibility, the W2 parity rule,
 * the publish decision and reading time.
 */
import type { PlatformBlogPost } from '@prisma/client';
import {
  affectsPublicSite,
  incompleteLocales,
  isPubliclyVisible,
  isTranslationComplete,
  readingMinutes,
  resolvePublish,
} from './blog-rules';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const PAST = new Date('2026-10-25T12:00:00.000Z');
const FUTURE = new Date('2026-10-27T12:00:00.000Z');

const complete = {
  title: 'Protecting your courses',
  excerpt: 'How Atlas keeps paid lessons for paying students only.',
  body: 'Body text.',
  coverAlt: 'A lock on a laptop',
  seoTitle: null,
  seoDescription: null,
};

function row(overrides: Partial<PlatformBlogPost> = {}): PlatformBlogPost {
  return {
    titleEn: complete.title,
    excerptEn: complete.excerpt,
    bodyEn: complete.body,
    coverAltEn: complete.coverAlt,
    seoTitleEn: null,
    seoDescriptionEn: null,
    titleAr: 'حماية دوراتك',
    excerptAr: 'كيف تحافظ أطلس على الدروس المدفوعة للطلاب الذين دفعوا فقط.',
    bodyAr: 'نص المقال.',
    coverAltAr: 'قفل على حاسوب',
    seoTitleAr: null,
    seoDescriptionAr: null,
    coverImageUrl: '/marketing-assets/blog/a.webp',
    status: 'draft',
    publishAt: null,
    ...overrides,
  } as PlatformBlogPost;
}

describe('visibility', () => {
  it('draft, archived and a future scheduled post are never public', () => {
    expect(isPubliclyVisible(row({ status: 'draft', publishAt: PAST }), NOW)).toBe(false);
    expect(isPubliclyVisible(row({ status: 'archived', publishAt: PAST }), NOW)).toBe(
      false,
    );
    expect(isPubliclyVisible(row({ status: 'scheduled', publishAt: FUTURE }), NOW)).toBe(
      false,
    );
    expect(isPubliclyVisible(row({ status: 'published', publishAt: null }), NOW)).toBe(
      false,
    );
  });

  it('a scheduled post becomes public at its publish time', () => {
    const scheduled = row({ status: 'scheduled', publishAt: FUTURE });
    expect(isPubliclyVisible(scheduled, new Date(FUTURE.getTime() - 1))).toBe(false);
    expect(isPubliclyVisible(scheduled, FUTURE)).toBe(true);
    expect(isPubliclyVisible(scheduled, new Date(FUTURE.getTime() + 1))).toBe(true);
  });

  it('a published post is public', () => {
    expect(isPubliclyVisible(row({ status: 'published', publishAt: PAST }), NOW)).toBe(
      true,
    );
  });

  it('only scheduled/published statuses touch the public site', () => {
    expect(affectsPublicSite('draft')).toBe(false);
    expect(affectsPublicSite('archived')).toBe(false);
    expect(affectsPublicSite('scheduled')).toBe(true);
    expect(affectsPublicSite('published')).toBe(true);
  });
});

describe('parity rule (both languages complete to publish)', () => {
  it('passes with both languages complete', () => {
    expect(incompleteLocales(row())).toEqual([]);
  });

  it('names a missing language', () => {
    expect(
      incompleteLocales(row({ titleAr: null, excerptAr: null, bodyAr: null })),
    ).toEqual(['ar']);
    expect(
      incompleteLocales(
        row({
          titleAr: null,
          excerptAr: null,
          bodyAr: null,
          titleEn: null,
          excerptEn: null,
          bodyEn: null,
        }),
      ),
    ).toEqual(['en', 'ar']);
  });

  it('enforces the minimum lengths and a non-blank body', () => {
    expect(isTranslationComplete({ ...complete, title: 'ab' }, false)).toBe(false);
    expect(isTranslationComplete({ ...complete, excerpt: 'too short' }, false)).toBe(
      false,
    );
    expect(isTranslationComplete({ ...complete, body: '   ' }, false)).toBe(false);
    expect(isTranslationComplete({ ...complete, title: 'x'.repeat(141) }, false)).toBe(
      false,
    );
    expect(isTranslationComplete(complete, false)).toBe(true);
  });

  it('requires alt text only when the post has a cover image', () => {
    expect(isTranslationComplete({ ...complete, coverAlt: null }, true)).toBe(false);
    expect(isTranslationComplete({ ...complete, coverAlt: '  ' }, true)).toBe(false);
    expect(isTranslationComplete({ ...complete, coverAlt: null }, false)).toBe(true);
    expect(incompleteLocales(row({ coverAltEn: null }))).toEqual(['en']);
    expect(incompleteLocales(row({ coverAltEn: null, coverImageUrl: null }))).toEqual([]);
  });
});

describe('resolvePublish', () => {
  it('no time or a past time publishes now', () => {
    expect(resolvePublish(undefined, NOW)).toEqual({
      status: 'published',
      publishAt: NOW,
    });
    expect(resolvePublish(PAST, NOW)).toEqual({ status: 'published', publishAt: NOW });
    expect(resolvePublish(NOW, NOW)).toEqual({ status: 'published', publishAt: NOW });
  });

  it('a future time schedules', () => {
    expect(resolvePublish(FUTURE, NOW)).toEqual({
      status: 'scheduled',
      publishAt: FUTURE,
    });
  });
});

describe('readingMinutes', () => {
  it('is null without a body', () => {
    expect(readingMinutes(null)).toBeNull();
    expect(readingMinutes('   ')).toBeNull();
  });

  it('is at least 1', () => {
    expect(readingMinutes('One word.')).toBe(1);
  });

  it('counts English words / 200, rounded up', () => {
    expect(readingMinutes(Array(200).fill('word').join(' '))).toBe(1);
    expect(readingMinutes(Array(201).fill('word').join(' '))).toBe(2);
    expect(readingMinutes(Array(1000).fill('word').join(' '))).toBe(5);
  });

  it('counts Arabic words the same way', () => {
    expect(readingMinutes(Array(400).fill('كلمة').join(' '))).toBe(2);
    expect(readingMinutes(Array(401).fill('كلمة').join('\n'))).toBe(3);
  });

  it('does not count markdown punctuation or link destinations as words', () => {
    const body = `# Title\n\n- - -\n\n${Array(200).fill('word').join(' ')} [link](https://a.example/very/long/path)`;
    // 1 title word + 200 words + "[link]" = 202 → 2 minutes; the URL adds nothing.
    expect(readingMinutes(body)).toBe(2);
    expect(readingMinutes('--- *** ### ```')).toBe(1);
  });
});
