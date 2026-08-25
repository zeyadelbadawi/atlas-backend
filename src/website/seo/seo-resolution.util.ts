/**
 * SEO resolution hierarchy (master plan §21 Phase P10) — a field-for-field
 * backend reproduction of the real frontend's `seo-resolution.utils.ts`.
 *
 * Deterministic, pure, and read-only: Page/Entity Override → Website
 * Global Default → Atlas System Fallback. No database dependency, no HTTP
 * dependency, no NestJS request context, no global mutable state — every
 * input is already-validated, already-fetched data the caller supplies.
 *
 * There is no HTTP endpoint anywhere in the real frontend contract that
 * calls a backend "resolve SEO" service — direct inspection confirms
 * `resolvePageSeo`/`resolveCourseSeo` run entirely client-side today
 * (`WebsitePageSeoDialog.tsx`, `PublicWebsitePage.tsx`), operating on data
 * the P9 endpoints already return. This backend reproduction exists so
 * P11's public runtime (server-side rendering, real meta tags) has the
 * exact same deterministic resolution logic available without either
 * duplicating it ad hoc or reaching back into a frontend-only module —
 * see this file's own unit tests for the precedence proof master plan
 * §21 P10's Definition of Done requires.
 *
 * Resolution is FIELD-LEVEL, not object-level: `title`/`description` each
 * independently fall through Override → Global → Fallback via `||` — a
 * page overriding only `metaTitle` still falls through to the Website
 * Global's `metaDescription`, never the page's own blank one. `ogTitle`/
 * `ogDescription` fall back to the already-resolved `title`/`description`
 * (not directly to Global), and `ogImage` is a simple two-level
 * Override → Global fallback with no system-default image. `indexable`
 * uses `??` (not `||`) because `false` is a meaningful, real value — and
 * is additionally gated by `page.visible`: a hidden page can never be
 * indexable regardless of any override, matching the frontend's own
 * explicit rule verbatim.
 *
 * `resolveBlogPostSeo` is deliberately NOT reproduced here — the
 * frontend's own `seo-resolution.utils.ts` marks it "UNRESOLVED... no
 * live UI consumer," confirmed by direct search (`resolveBlogPostSeo` is
 * never actually called anywhere in the real frontend, including
 * `WebsiteBlogContentTab.tsx`, whose doc comment references it but whose
 * code does not call it). Blog/Announcements are also outside the
 * Website/CMS domain (Community, P7) — porting a function the frontend
 * itself documents as unused would be inventing scope, not reproducing a
 * real contract.
 */
import type {
  CourseSeoInput,
  ResolvedSeoMetadata,
  SeoFallback,
  WebsiteConfigurationSeoInput,
  WebsitePageInput,
} from './seo.types';

export function resolvePageSeo(
  page: WebsitePageInput,
  configuration: WebsiteConfigurationSeoInput,
  fallback: SeoFallback,
): ResolvedSeoMetadata {
  const title = page.seo.metaTitle || configuration.seo.metaTitle || fallback.title;
  const titleSource: ResolvedSeoMetadata['titleSource'] = page.seo.metaTitle
    ? 'override'
    : configuration.seo.metaTitle
      ? 'global'
      : 'fallback';

  const description =
    page.seo.metaDescription || configuration.seo.metaDescription || fallback.description;
  const descriptionSource: ResolvedSeoMetadata['descriptionSource'] = page.seo
    .metaDescription
    ? 'override'
    : configuration.seo.metaDescription
      ? 'global'
      : 'fallback';

  return {
    title,
    description,
    ogTitle: page.seo.ogTitle || title,
    ogDescription: page.seo.ogDescription || description,
    ogImage: page.seo.ogImage || configuration.seo.ogImage,
    canonicalPath: page.seo.canonicalPath || `/${page.slug}`,
    // A hidden page can never be indexable, regardless of any override.
    indexable:
      page.visible && (page.seo.indexable ?? configuration.seo.robotsIndexable ?? true),
    titleSource,
    descriptionSource,
  };
}

/** Dynamic SEO for a Course — reads the EXISTING Course domain only, never a duplicated projection stored in the CMS. */
export function resolveCourseSeo(
  course: CourseSeoInput,
  configuration: WebsiteConfigurationSeoInput,
  fallback: SeoFallback,
): ResolvedSeoMetadata {
  const title = course.title || fallback.title;
  const description =
    course.shortDescription ||
    course.description ||
    configuration.seo.metaDescription ||
    fallback.description;

  const publiclyReachable =
    course.status === 'published' && course.visibility === 'public';

  return {
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogImage: course.thumbnail || configuration.seo.ogImage,
    canonicalPath: `/courses/${course.slug}`,
    indexable: publiclyReachable && (configuration.seo.robotsIndexable ?? true),
    titleSource: course.title ? 'override' : 'fallback',
    descriptionSource:
      course.shortDescription || course.description ? 'override' : 'fallback',
  };
}
