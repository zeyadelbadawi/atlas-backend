/**
 * SEO / structured-data types (master plan §21 Phase P10) — a field-for-
 * field backend reproduction of the real frontend's `website-seo.types.ts`.
 *
 * These are pure data shapes only — no Prisma/HTTP/NestJS import anywhere
 * in this directory. `WebsitePageSeoInput`/`WebsiteSeoConfigInput` are
 * deliberately narrower than the full `WebsitePageResponse.seo`/
 * `WebsiteConfigurationResponse.seo` (`Record<string, unknown>`, P9) —
 * the resolver only ever reads the specific fields below, and a caller
 * passes its already-persisted JSONB cast to this narrower shape (the
 * same "structural subset, not the full authenticated type" pattern the
 * frontend's own `buildOrganizationJsonLd` already established for
 * `Academy`).
 *
 * Phase 6 (Bilingual Academy Websites) — every SEO title/description field
 * is `LocalizedText`, and `resolvePageSeo` takes an explicit `locale`
 * parameter: `/about` and `/ar/about` are two distinct indexed URLs (see
 * `hreflangAlternates` below), so resolution happens once per locale, not
 * once per page.
 */
import type { LocalizedTextLike } from '../utils/localized-text.util';
import type { PublicWebsiteLocale } from '../constants/locale.constants';

export type SeoResolutionSource = 'override' | 'global' | 'fallback';

/** One `<link rel="alternate" hreflang="...">` entry per supported locale — matches Google's documented "self-referencing hreflang" requirement (the resolved page's own locale is included, pointing at itself). */
export interface HreflangAlternate {
  readonly locale: PublicWebsiteLocale;
  /** Always a full, already-locale-prefixed path (`/ar/about`, or `/about` for `en`) — the renderer emits this verbatim, it never re-derives the prefix. */
  readonly path: string;
}

export interface ResolvedSeoMetadata {
  readonly title: string;
  readonly description: string;
  readonly ogTitle: string;
  readonly ogDescription: string;
  readonly ogImage?: string;
  readonly canonicalPath?: string;
  readonly indexable: boolean;
  readonly titleSource: SeoResolutionSource;
  readonly descriptionSource: SeoResolutionSource;
  readonly locale: PublicWebsiteLocale;
  readonly hreflangAlternates: readonly HreflangAlternate[];
}

export interface SeoFallback {
  readonly title: string;
  readonly description: string;
}

/** Matches `WebsitePageSeo` (`website.types.ts`, P9) exactly. */
export interface WebsitePageSeoInput {
  readonly metaTitle?: LocalizedTextLike;
  readonly metaDescription?: LocalizedTextLike;
  readonly ogTitle?: LocalizedTextLike;
  readonly ogDescription?: LocalizedTextLike;
  readonly ogImage?: string;
  readonly canonicalPath?: string;
  readonly indexable?: boolean;
}

export interface WebsitePageInput {
  readonly slug: string;
  readonly visible: boolean;
  readonly seo: WebsitePageSeoInput;
}

/** Matches `WebsiteSeoConfig` (`website.types.ts`, P9) exactly. */
export interface WebsiteSeoConfigInput {
  readonly siteTitle?: LocalizedTextLike;
  readonly metaTitle?: LocalizedTextLike;
  readonly metaDescription?: LocalizedTextLike;
  readonly ogImage?: string;
  readonly robotsIndexable?: boolean;
  readonly sitemapEnabled?: boolean;
  readonly canonicalBaseUrl?: string;
}

export interface WebsiteConfigurationSeoInput {
  readonly seo: WebsiteSeoConfigInput;
}

/** The narrow structural subset of `CourseResponse` (P5) `resolveCourseSeo` actually reads — never a duplicated Course projection. */
export interface CourseSeoInput {
  readonly title: string;
  readonly slug: string;
  readonly description?: string;
  readonly shortDescription?: string;
  readonly thumbnail?: string;
  readonly status: string;
  readonly visibility: string;
}

/** https://schema.org/Organization — built from the existing Academy record only. */
export interface OrganizationJsonLd {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'Organization';
  readonly name: string;
  readonly description?: string;
  readonly logo?: string;
  readonly email?: string;
  readonly telephone?: string;
}

/** https://schema.org/Course — built from the existing Course domain only, never a duplicated projection. */
export interface CourseJsonLd {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'Course';
  readonly name: string;
  readonly description?: string;
  readonly provider: { readonly '@type': 'Organization'; readonly name: string };
}

export interface SeoBreadcrumbItem {
  readonly name: string;
  readonly path: string;
}

/** https://schema.org/BreadcrumbList */
export interface BreadcrumbJsonLd {
  readonly '@context': 'https://schema.org';
  readonly '@type': 'BreadcrumbList';
  readonly itemListElement: ReadonlyArray<{
    readonly '@type': 'ListItem';
    readonly position: number;
    readonly name: string;
    readonly item: string;
  }>;
}
