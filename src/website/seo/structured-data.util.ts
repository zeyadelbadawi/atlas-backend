/**
 * Structured data (JSON-LD) builders (master plan §21 Phase P10) — pure
 * functions, a field-for-field backend reproduction of the real
 * frontend's `structured-data.utils.ts`. Turn real, typed Atlas data into
 * plain schema.org fragments — never hand-authored strings, never raw
 * HTML. No database dependency, no HTTP dependency, no NestJS request
 * context: every input is data the caller already has.
 *
 * As with `seo-resolution.util.ts`, there is no HTTP endpoint anywhere in
 * the real frontend contract for "get structured data" — these run
 * entirely client-side today (`WebsiteSeoTab.tsx`'s read-only JSON
 * preview, `PublicWebsitePage.tsx`). This backend reproduction exists as
 * the deterministic library P11's public runtime will need to serialize
 * into a real `<script type="application/ld+json">` tag server-side.
 *
 * `buildArticleJsonLd` (Blog) is deliberately NOT reproduced here — same
 * reasoning as `resolveBlogPostSeo`'s omission (see
 * `seo-resolution.util.ts`'s doc comment): confirmed, by direct search,
 * to have zero live call sites anywhere in the real frontend.
 */
import type {
  BreadcrumbJsonLd,
  CourseJsonLd,
  CourseSeoInput,
  OrganizationJsonLd,
  SeoBreadcrumbItem,
} from './seo.types';

/** Accepts a structural SUBSET of the Academy response (not the full type) — matches the frontend's own `Pick<Academy, 'name'|'description'|'logo'|'contactEmail'|'contactPhone'>` reasoning: a caller with only a narrower academy summary can still call this without a second, otherwise-unnecessary Academy fetch. */
export function buildOrganizationJsonLd(academy: {
  readonly name: string;
  readonly description?: string;
  readonly logo?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
}): OrganizationJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: academy.name,
    description: academy.description,
    logo: academy.logo,
    email: academy.contactEmail,
    telephone: academy.contactPhone,
  };
}

export function buildCourseJsonLd(
  course: CourseSeoInput,
  academy: { readonly name: string },
): CourseJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: course.title,
    description: course.shortDescription || course.description,
    provider: { '@type': 'Organization', name: academy.name },
  };
}

export function buildBreadcrumbJsonLd(
  items: readonly SeoBreadcrumbItem[],
): BreadcrumbJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.path,
    })),
  };
}
