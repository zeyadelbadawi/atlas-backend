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
 * Phase 6 (Bilingual Academy Websites) — every title/description field is
 * now `LocalizedText`, and both resolvers take an explicit `locale`
 * parameter: the fall-through precedence (Override → Global → Fallback)
 * is unchanged, it now simply runs once PER LOCALE, resolving each
 * `LocalizedText` field to its `locale` side (falling back to `en` when
 * `ar` is blank, per `resolveLocalizedText`) before applying the same
 * `||`/`??` precedence rules as before. `resolvePageSeo` additionally
 * returns `hreflangAlternates` — one entry per supported locale, pointing
 * at that locale's own URL for the same page — so the public runtime can
 * emit `<link rel="alternate" hreflang="...">` tags without a second
 * resolution pass. `resolveBlogPostSeo` is deliberately NOT reproduced
 * here — the frontend's own `seo-resolution.utils.ts` marks it
 * "UNRESOLVED... no live UI consumer" (see prior revisions of this file's
 * doc comment).
 */
import {
  PUBLIC_WEBSITE_LOCALES,
  type PublicWebsiteLocale,
} from '../constants/locale.constants';
import { resolveLocalizedText } from '../utils/localized-text.util';
import type {
  CourseSeoInput,
  HreflangAlternate,
  ResolvedSeoMetadata,
  SeoFallback,
  WebsiteConfigurationSeoInput,
  WebsitePageInput,
} from './seo.types';

/** `/ar/about` for `ar`, `/about` for `en` — the ONE place the locale URL prefix is applied when building hreflang alternates, matching the frontend router's own prefix rule (`locale.constants.ts`, `PUBLIC_WEBSITE_LOCALE_PATH_PREFIX`). */
function withLocalePrefix(path: string, locale: PublicWebsiteLocale): string {
  return locale === 'en' ? path : `/${locale}${path}`;
}

function buildHreflangAlternates(canonicalPath: string): readonly HreflangAlternate[] {
  return PUBLIC_WEBSITE_LOCALES.map((locale) => ({
    locale,
    path: withLocalePrefix(canonicalPath, locale),
  }));
}

export function resolvePageSeo(
  page: WebsitePageInput,
  configuration: WebsiteConfigurationSeoInput,
  fallback: SeoFallback,
  locale: PublicWebsiteLocale,
): ResolvedSeoMetadata {
  const pageMetaTitle = resolveLocalizedText(page.seo.metaTitle, locale);
  const globalMetaTitle = resolveLocalizedText(configuration.seo.metaTitle, locale);
  const title = pageMetaTitle || globalMetaTitle || fallback.title;
  const titleSource: ResolvedSeoMetadata['titleSource'] = pageMetaTitle
    ? 'override'
    : globalMetaTitle
      ? 'global'
      : 'fallback';

  const pageMetaDescription = resolveLocalizedText(page.seo.metaDescription, locale);
  const globalMetaDescription = resolveLocalizedText(
    configuration.seo.metaDescription,
    locale,
  );
  const description =
    pageMetaDescription || globalMetaDescription || fallback.description;
  const descriptionSource: ResolvedSeoMetadata['descriptionSource'] = pageMetaDescription
    ? 'override'
    : globalMetaDescription
      ? 'global'
      : 'fallback';

  const canonicalPath = page.seo.canonicalPath || `/${page.slug}`;

  return {
    title,
    description,
    ogTitle: resolveLocalizedText(page.seo.ogTitle, locale) || title,
    ogDescription: resolveLocalizedText(page.seo.ogDescription, locale) || description,
    ogImage: page.seo.ogImage || configuration.seo.ogImage,
    canonicalPath,
    // A hidden page can never be indexable, regardless of any override.
    indexable:
      page.visible && (page.seo.indexable ?? configuration.seo.robotsIndexable ?? true),
    titleSource,
    descriptionSource,
    locale,
    hreflangAlternates: buildHreflangAlternates(canonicalPath),
  };
}

/** Dynamic SEO for a Course — reads the EXISTING Course domain only, never a duplicated projection stored in the CMS. Course title/description are not `LocalizedText` today (the Course domain predates Phase 6 and is out of this phase's scope — see the Phase 6 completion report's "remaining limitations"), so `locale` only affects which side of the WEBSITE's own global SEO defaults/hreflang is used, not the course copy itself. */
export function resolveCourseSeo(
  course: CourseSeoInput,
  configuration: WebsiteConfigurationSeoInput,
  fallback: SeoFallback,
  locale: PublicWebsiteLocale,
): ResolvedSeoMetadata {
  const title = course.title || fallback.title;
  const description =
    course.shortDescription ||
    course.description ||
    resolveLocalizedText(configuration.seo.metaDescription, locale) ||
    fallback.description;

  const publiclyReachable =
    course.status === 'published' && course.visibility === 'public';
  const canonicalPath = `/courses/${course.slug}`;

  return {
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogImage: course.thumbnail || configuration.seo.ogImage,
    canonicalPath,
    indexable: publiclyReachable && (configuration.seo.robotsIndexable ?? true),
    titleSource: course.title ? 'override' : 'fallback',
    descriptionSource:
      course.shortDescription || course.description ? 'override' : 'fallback',
    locale,
    hreflangAlternates: buildHreflangAlternates(canonicalPath),
  };
}
