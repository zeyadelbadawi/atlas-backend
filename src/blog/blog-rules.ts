/**
 * B3 — the marketing blog's pure rules: who may see a post, what a
 * complete translation is (the W2 parity rule), how a publish request is
 * resolved, and the server-computed reading time. No I/O here, so every
 * rule is unit-tested directly (`blog-rules.spec.ts`).
 */
import type { PlatformBlogPost, PlatformBlogPostStatus, Prisma } from '@prisma/client';

export const BLOG_LOCALES = ['en', 'ar'] as const;
export type BlogLocale = (typeof BLOG_LOCALES)[number];

export const BLOG_KINDS = ['pillar', 'cluster', 'article'] as const;
export const BLOG_TOPICS = [
  'protection',
  'payments',
  'exams',
  'website',
  'season',
  'teaching',
  'news',
] as const;
export const BLOG_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;

export const BLOG_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BLOG_SLUG_MIN = 3;
export const BLOG_SLUG_MAX = 80;

export const BLOG_LIMITS = {
  title: { min: 3, max: 140 },
  excerpt: { min: 20, max: 300 },
  body: { min: 1, max: 60_000 },
  coverAlt: { max: 200 },
  seoTitle: { max: 70 },
  seoDescription: { max: 170 },
  authorName: { min: 1, max: 80 },
  relatedPosts: { max: 3 },
} as const;

export const BLOG_DEFAULT_AUTHOR = 'Atlas team';
export const BLOG_WORDS_PER_MINUTE = 200;

/** The stored columns of one language. */
export interface BlogTranslationColumns {
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
  readonly coverAlt: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

type TranslationRow = Pick<
  PlatformBlogPost,
  | 'titleEn'
  | 'excerptEn'
  | 'bodyEn'
  | 'coverAltEn'
  | 'seoTitleEn'
  | 'seoDescriptionEn'
  | 'titleAr'
  | 'excerptAr'
  | 'bodyAr'
  | 'coverAltAr'
  | 'seoTitleAr'
  | 'seoDescriptionAr'
>;

export function translationColumns(
  row: TranslationRow,
  locale: BlogLocale,
): BlogTranslationColumns {
  return locale === 'en'
    ? {
        title: row.titleEn,
        excerpt: row.excerptEn,
        body: row.bodyEn,
        coverAlt: row.coverAltEn,
        seoTitle: row.seoTitleEn,
        seoDescription: row.seoDescriptionEn,
      }
    : {
        title: row.titleAr,
        excerpt: row.excerptAr,
        body: row.bodyAr,
        coverAlt: row.coverAltAr,
        seoTitle: row.seoTitleAr,
        seoDescription: row.seoDescriptionAr,
      };
}

/** A language is present when any of its title, excerpt or body is set. */
export function hasTranslation(columns: BlogTranslationColumns): boolean {
  return !!(columns.title || columns.excerpt || columns.body);
}

/**
 * Complete enough to be public: title 3..140, excerpt 20..300, a non-blank
 * body, and alt text when the post has a cover image.
 */
export function isTranslationComplete(
  columns: BlogTranslationColumns,
  hasCoverImage: boolean,
): boolean {
  const title = columns.title?.trim() ?? '';
  const excerpt = columns.excerpt?.trim() ?? '';
  const body = columns.body ?? '';
  if (title.length < BLOG_LIMITS.title.min || title.length > BLOG_LIMITS.title.max)
    return false;
  if (
    excerpt.length < BLOG_LIMITS.excerpt.min ||
    excerpt.length > BLOG_LIMITS.excerpt.max
  ) {
    return false;
  }
  if (body.trim().length < BLOG_LIMITS.body.min || body.length > BLOG_LIMITS.body.max)
    return false;
  if (hasCoverImage && !columns.coverAlt?.trim()) return false;
  return true;
}

/** The languages that stop a post from going public (the W2 parity rule: both are required). */
export function incompleteLocales(
  row: TranslationRow & Pick<PlatformBlogPost, 'coverImageUrl'>,
): BlogLocale[] {
  const hasCover = !!row.coverImageUrl;
  return BLOG_LOCALES.filter(
    (locale) => !isTranslationComplete(translationColumns(row, locale), hasCover),
  );
}

/** Public = scheduled or published, with its publish time reached. */
export function isPubliclyVisible(
  row: Pick<PlatformBlogPost, 'status' | 'publishAt'>,
  now: Date,
): boolean {
  return (
    (row.status === 'scheduled' || row.status === 'published') &&
    row.publishAt !== null &&
    row.publishAt.getTime() <= now.getTime()
  );
}

/**
 * The status the Platform Owner sees: a scheduled post whose time has come
 * IS published (nothing rewrites the row when the time passes), so the
 * dashboard shows, counts and filters it as published.
 */
export function effectiveStatus(
  row: Pick<PlatformBlogPost, 'status' | 'publishAt'>,
  now: Date,
): PlatformBlogPostStatus {
  return row.status === 'scheduled' && isPubliclyVisible(row, now)
    ? 'published'
    : row.status;
}

/** The `status` filter of the Platform Owner list, by effective status. */
export function effectiveStatusWhere(
  status: PlatformBlogPostStatus,
  now: Date,
): Prisma.PlatformBlogPostWhereInput {
  if (status === 'published') {
    return {
      OR: [{ status: 'published' }, { status: 'scheduled', publishAt: { lte: now } }],
    };
  }
  if (status === 'scheduled') {
    return { status: 'scheduled', OR: [{ publishAt: null }, { publishAt: { gt: now } }] };
  }
  return { status };
}

/** Statuses whose rows the public can see now or will see without another write. */
export function affectsPublicSite(status: PlatformBlogPostStatus): boolean {
  return status === 'scheduled' || status === 'published';
}

/**
 * A publish request: no time, or a time not after now, publishes now; a
 * future time schedules.
 */
export function resolvePublish(
  requested: Date | undefined,
  now: Date,
): { status: 'published' | 'scheduled'; publishAt: Date } {
  if (!requested || requested.getTime() <= now.getTime()) {
    return { status: 'published', publishAt: now };
  }
  return { status: 'scheduled', publishAt: requested };
}

/**
 * Reading time in whole minutes: words / 200, rounded up, at least 1.
 * A word is any whitespace-separated token with a letter or digit in any
 * script, so Arabic and English count the same way. Link and image
 * destinations and code-fence markers are not words.
 */
export function readingMinutes(body: string | null | undefined): number | null {
  if (!body || !body.trim()) return null;
  const text = body
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/<[^>]+>/g, ' ');
  const words = text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return Math.max(1, Math.ceil(words / BLOG_WORDS_PER_MINUTE));
}
