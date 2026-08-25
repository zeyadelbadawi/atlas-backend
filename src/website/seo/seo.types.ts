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
 */

export type SeoResolutionSource = 'override' | 'global' | 'fallback';

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
}

export interface SeoFallback {
  readonly title: string;
  readonly description: string;
}

/** Matches `WebsitePageSeo` (`website.types.ts`, P9) exactly. */
export interface WebsitePageSeoInput {
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly ogTitle?: string;
  readonly ogDescription?: string;
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
  readonly siteTitle?: string;
  readonly metaTitle?: string;
  readonly metaDescription?: string;
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
