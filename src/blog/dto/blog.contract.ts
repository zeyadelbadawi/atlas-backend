/**
 * B3 — marketing blog response shapes (Platform Owner and public).
 * Matched field-for-field by the frontend's blog service types.
 */
import type { BlogLocale } from '../blog-rules';

export type BlogPostKind = 'pillar' | 'cluster' | 'article';
export type BlogPostTopic =
  'protection' | 'payments' | 'exams' | 'website' | 'season' | 'teaching' | 'news';
export type BlogPostStatus = 'draft' | 'scheduled' | 'published' | 'archived';

export interface BlogCoverImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** One language of a post. Unset text is `''`; unset SEO fields are `null`. */
export interface BlogTranslation {
  readonly title: string;
  readonly excerpt: string;
  readonly body: string;
  readonly coverAlt: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
}

/** The list row's language: title and excerpt only (bodies stay out of lists). */
export interface BlogTranslationSummary {
  readonly title: string;
  readonly excerpt: string;
}

interface BlogPostBase {
  readonly id: string;
  readonly slug: string;
  readonly kind: BlogPostKind;
  readonly topic: BlogPostTopic;
  readonly status: BlogPostStatus;
  readonly publishAt: string | null;
  /** True when the public can read it right now (status + publishAt). */
  readonly isPublic: boolean;
  readonly featured: boolean;
  readonly coverImage: BlogCoverImage | null;
  readonly authorName: string;
  readonly relatedPostIds: readonly string[];
  readonly readingMinutes: { readonly en: number | null; readonly ar: number | null };
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly createdByName: string | null;
  readonly updatedByName: string | null;
}

/** `GET /platform-blog-posts` rows. */
export interface BlogPostListItem extends BlogPostBase {
  readonly translations: {
    readonly en: BlogTranslationSummary | null;
    readonly ar: BlogTranslationSummary | null;
  };
}

/** `GET /platform-blog-posts/:id` and every write's response. */
export interface BlogPostDetail extends BlogPostBase {
  readonly translations: {
    readonly en: BlogTranslation | null;
    readonly ar: BlogTranslation | null;
  };
}

export interface PublicBlogPostSummary {
  readonly slug: string;
  readonly kind: BlogPostKind;
  readonly topic: BlogPostTopic;
  readonly featured: boolean;
  readonly publishAt: string | null;
  readonly updatedAt: string;
  readonly coverImage: BlogCoverImage | null;
  readonly coverAlt: string;
  readonly title: string;
  readonly excerpt: string;
  readonly readingMinutes: number;
  readonly authorName: string;
}

export interface PublicBlogPost extends PublicBlogPostSummary {
  readonly locale: BlogLocale;
  readonly body: string;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly related: readonly PublicBlogPostSummary[];
  readonly alternateLocaleAvailable: boolean;
}

export interface PublicBlogSitemap {
  readonly items: readonly {
    readonly slug: string;
    readonly updatedAt: string;
    readonly locales: readonly BlogLocale[];
  }[];
}

export interface BlogImageUploadResult {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}
