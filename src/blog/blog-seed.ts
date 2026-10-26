/**
 * B3 — the marketing blog seed file: parsing and validation, kept pure so
 * the script (`src/scripts/seed-blog-posts.ts`) and its spec share it.
 *
 * FILE SHAPE (JSON): an array of posts, or `{ "posts": [...] }`.
 *
 *   {
 *     "slug": "protect-your-courses",          // the upsert key
 *     "kind": "pillar", "topic": "protection",
 *     "featured": true,                          // optional
 *     "authorName": "Atlas team",                // optional
 *     "coverImage": { "url": "/marketing-assets/blog/x.webp", "width": 1200, "height": 630 },
 *     "relatedSlugs": ["other-post"],            // 0..3, resolved after every post is upserted
 *     "status": "published",                     // draft | scheduled | published (default draft)
 *     "publishAt": "2026-11-02T08:00:00Z",       // optional; a PAST date backdates a published post
 *     "translations": {
 *       "en": { "title", "excerpt", "body", "coverAlt", "seoTitle", "seoDescription" },
 *       "ar": { ... }
 *     }
 *   }
 *
 * Every entry is checked with the API's own DTO rules (lengths, slug,
 * URL schemes, markdown links and images), and a post that is to be
 * public must have both languages complete — the same refusals the
 * dashboard would get.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { findUnsafeMarkdownUrls } from '../common/validation/safe-url.util';
import { CreateBlogPostDto } from './dto/blog.dto';
import { incompleteLocales, BLOG_SLUG_PATTERN } from './blog-rules';
import { normalizeTranslation } from './services/platform-blog-posts.service';

export interface BlogSeedEntry {
  readonly post: CreateBlogPostDto;
  readonly relatedSlugs: readonly string[];
  readonly status: 'draft' | 'scheduled' | 'published';
  readonly publishAt?: Date;
}

export class BlogSeedError extends Error {}

function flattenErrors(errors: ReturnType<typeof validateSync>, prefix = ''): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}).map((message) => `${prefix}${message}`),
    ...flattenErrors(error.children ?? [], `${prefix}${error.property}.`),
  ]);
}

/** Parses and validates a seed file's JSON; throws `BlogSeedError` listing every problem. */
export function parseBlogSeed(json: unknown): BlogSeedEntry[] {
  const list = Array.isArray(json)
    ? json
    : json &&
        typeof json === 'object' &&
        Array.isArray((json as { posts?: unknown }).posts)
      ? (json as { posts: unknown[] }).posts
      : null;
  if (!list)
    throw new BlogSeedError(
      'The seed file must be an array of posts or { "posts": [...] }.',
    );

  const problems: string[] = [];
  const slugs = new Set<string>();
  const entries: BlogSeedEntry[] = [];
  list.forEach((raw, index) => {
    const label = `#${index + 1}`;
    if (!raw || typeof raw !== 'object') {
      problems.push(`${label}: not an object`);
      return;
    }
    const {
      relatedSlugs = [],
      status = 'draft',
      publishAt,
      ...fields
    } = raw as Record<string, unknown>;
    const post = plainToInstance(CreateBlogPostDto, fields);
    const errors = flattenErrors(
      validateSync(post, { whitelist: true, forbidNonWhitelisted: true }),
    );
    const name = `${label} (${String(fields.slug ?? '?')})`;
    for (const error of errors) problems.push(`${name}: ${error}`);
    if (!['draft', 'scheduled', 'published'].includes(String(status))) {
      problems.push(`${name}: status must be draft, scheduled or published`);
    }
    const when = publishAt === undefined ? undefined : new Date(String(publishAt));
    if (when && Number.isNaN(when.getTime()))
      problems.push(`${name}: publishAt is not a date`);
    if (
      !Array.isArray(relatedSlugs) ||
      relatedSlugs.length > 3 ||
      relatedSlugs.some(
        (slug) => typeof slug !== 'string' || !BLOG_SLUG_PATTERN.test(slug),
      )
    ) {
      problems.push(`${name}: relatedSlugs must be 0..3 slugs`);
    }
    if (typeof post.slug === 'string') {
      if (slugs.has(post.slug)) problems.push(`${name}: duplicate slug`);
      slugs.add(post.slug);
    }
    const en = normalizeTranslation(post.translations?.en);
    const ar = normalizeTranslation(post.translations?.ar);
    for (const [locale, body] of [
      ['en', en.body],
      ['ar', ar.body],
    ] as const) {
      const unsafe = body ? findUnsafeMarkdownUrls(body) : [];
      if (unsafe.length > 0) {
        problems.push(
          `${name}: unsafe ${unsafe[0].kind} URL in ${locale} body: ${unsafe[0].url}`,
        );
      }
    }
    if (status !== 'draft') {
      const missing = incompleteLocales({
        coverImageUrl: post.coverImage?.url ?? null,
        titleEn: en.title,
        excerptEn: en.excerpt,
        bodyEn: en.body,
        coverAltEn: en.coverAlt,
        seoTitleEn: en.seoTitle,
        seoDescriptionEn: en.seoDescription,
        titleAr: ar.title,
        excerptAr: ar.excerpt,
        bodyAr: ar.body,
        coverAltAr: ar.coverAlt,
        seoTitleAr: ar.seoTitle,
        seoDescriptionAr: ar.seoDescription,
      });
      if (missing.length > 0) {
        problems.push(
          `${name}: incomplete translations for ${missing.join(', ')} (required to publish)`,
        );
      }
    }
    entries.push({
      post,
      relatedSlugs: Array.isArray(relatedSlugs) ? (relatedSlugs as string[]) : [],
      status: status as BlogSeedEntry['status'],
      ...(when ? { publishAt: when } : {}),
    });
  });
  for (const entry of entries) {
    for (const slug of entry.relatedSlugs) {
      if (slug === entry.post.slug)
        problems.push(`${entry.post.slug}: relates to itself`);
    }
  }
  if (problems.length > 0) throw new BlogSeedError(problems.join('\n'));
  return entries;
}
