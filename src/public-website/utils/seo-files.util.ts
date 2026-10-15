/**
 * B0-WEB-01 — an Academy's own `robots.txt` and `sitemap.xml`.
 *
 * Pure functions: the controller feeds them the Academy's published
 * configuration, pages and courses. Before this, every academy subdomain
 * and custom domain was served the PLATFORM's static robots.txt and
 * sitemap (Caddy serves existing files first), so the Academy's own
 * "allow search engines" and "sitemap" settings had no effect.
 *
 * Paths follow the public router exactly (`resolvePagePath` and
 * `resolvePathToPage` in the frontend): home is `/`, a core page is
 * `/<coreType>`, a custom page is `/<slug>`, a course is
 * `/courses/<slug>`; the course-details template page itself is never a
 * URL. Every URL is listed in the site's default language (unprefixed) with
 * its other-language alternate under that language's prefix, and
 * `x-default` points at the default language. B0-WEB-02: the default is
 * English (alternate under `/ar`) unless the owner made it Arabic
 * (alternate under `/en`).
 */
import {
  DEFAULT_PUBLIC_WEBSITE_LOCALE,
  PUBLIC_WEBSITE_LOCALES,
  localePathPrefix,
  type PublicWebsiteLocale,
} from '../../website/constants/locale.constants';

export interface SeoFilePage {
  readonly pageType: string;
  readonly coreType?: string | null;
  readonly slug: string;
  readonly visible: boolean;
  readonly updatedAt: string;
  readonly seo?: Record<string, unknown> | null;
}

export interface SeoFileCourse {
  readonly slug: string;
  readonly status: string;
  readonly visibility: string;
  readonly updatedAt: string;
}

export interface SitemapUrl {
  readonly path: string;
  readonly lastModified: string;
  readonly changeFrequency: 'weekly' | 'monthly';
  readonly priority: number;
}

/** The public path a page is served at, or `undefined` when it is not a URL of its own. */
export function publicPagePath(page: SeoFilePage): string | undefined {
  if (page.coreType === 'home') return '/';
  if (page.coreType === 'courseDetails') return undefined;
  if (page.coreType) return `/${page.coreType}`;
  return `/${page.slug}`;
}

/** Published, visible, indexable pages and published public courses, in that order. */
export function buildSitemapUrls(
  pages: readonly SeoFilePage[],
  courses: readonly SeoFileCourse[],
): readonly SitemapUrl[] {
  const seen = new Set<string>();
  const urls: SitemapUrl[] = [];
  for (const page of pages) {
    if (!page.visible || page.seo?.indexable === false) continue;
    const path = publicPagePath(page);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    urls.push({
      path,
      lastModified: page.updatedAt,
      changeFrequency: page.coreType === 'home' ? 'weekly' : 'monthly',
      priority: page.coreType === 'home' ? 1 : 0.6,
    });
  }
  for (const course of courses) {
    if (course.status !== 'published' || course.visibility !== 'public') continue;
    const path = `/courses/${encodeURIComponent(course.slug)}`;
    if (seen.has(path)) continue;
    seen.add(path);
    urls.push({
      path,
      lastModified: course.updatedAt,
      changeFrequency: 'weekly',
      priority: 0.8,
    });
  }
  return urls;
}

/** `Disallow: /` unless the Academy is published and allows indexing; a `Sitemap:` line only when one is served. */
export function buildRobotsTxt(input: {
  readonly indexable: boolean;
  readonly sitemapUrl?: string;
}): string {
  const lines = ['User-agent: *', input.indexable ? 'Allow: /' : 'Disallow: /'];
  if (input.indexable && input.sitemapUrl) lines.push('', `Sitemap: ${input.sitemapUrl}`);
  return `${lines.join('\n')}\n`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `path` (unprefixed, e.g. `/about` or `/`) as served in `locale`: `/ar/about`, `/ar` for the root. */
export function localizedSitePath(
  path: string,
  locale: PublicWebsiteLocale,
  defaultLocale: PublicWebsiteLocale = DEFAULT_PUBLIC_WEBSITE_LOCALE,
): string {
  const prefix = localePathPrefix(locale, defaultLocale);
  if (!prefix) return path;
  return path === '/' ? prefix : `${prefix}${path}`;
}

/**
 * `origin` is the Academy's canonical origin, e.g. `https://elzozo.atlass.dpdns.org`.
 * Each `<url>` is the default-language URL with one alternate per language
 * (always `en` then `ar`, so every page's set is reciprocal) and `x-default`.
 */
export function buildSitemapXml(
  urls: readonly SitemapUrl[],
  origin: string,
  defaultLocale: PublicWebsiteLocale = DEFAULT_PUBLIC_WEBSITE_LOCALE,
): string {
  const nodes = urls.map((url) => {
    const href = (locale: PublicWebsiteLocale) =>
      escapeXml(origin + localizedSitePath(url.path, locale, defaultLocale));
    const main = href(defaultLocale);
    return [
      '  <url>',
      `    <loc>${main}</loc>`,
      ...PUBLIC_WEBSITE_LOCALES.map(
        (locale) =>
          `    <xhtml:link rel="alternate" hreflang="${locale}" href="${href(locale)}"/>`,
      ),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${main}"/>`,
      `    <lastmod>${escapeXml(url.lastModified)}</lastmod>`,
      `    <changefreq>${url.changeFrequency}</changefreq>`,
      `    <priority>${url.priority.toFixed(1)}</priority>`,
      '  </url>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...nodes,
    '</urlset>',
    '',
  ].join('\n');
}
