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
export function publicPagePath(
  page: Pick<SeoFilePage, 'coreType' | 'slug'>,
): string | undefined {
  if (page.coreType === 'home') return '/';
  if (page.coreType === 'courseDetails') return undefined;
  if (page.coreType) return `/${page.coreType}`;
  return `/${page.slug}`;
}

/** The later of two ISO timestamps (an absent one loses). */
function latest(a: string, b: string | undefined): string {
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Published, visible, indexable pages and published public courses, in that
 * order. `sitePublishedAt` — the website's last publish — dates a page whose
 * own row is older: a publish changes what every page shows (navigation,
 * header, footer), and Bing and Google use `<lastmod>` only while it stays
 * accurate.
 */
export function buildSitemapUrls(
  pages: readonly SeoFilePage[],
  courses: readonly SeoFileCourse[],
  sitePublishedAt?: string,
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
      lastModified: latest(page.updatedAt, sitePublishedAt),
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

/**
 * `Disallow: /` unless the Academy is published and allows indexing; a
 * `Sitemap:` line only when one is served.
 *
 * One `User-agent: *` group on purpose (SEO/AEO/GEO pass, Nov 2026): every
 * crawler without a group of its own follows it, so search engines
 * (Googlebot, Bingbot, Applebot), AI search and answer crawlers
 * (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot,
 * Claude-User) and the AI-use tokens (GPTBot, ClaudeBot, Google-Extended —
 * which also governs grounding in Gemini — Applebot-Extended) are all
 * allowed by default. Naming each one with the same rule would change
 * nothing. Sign-in and learner pages are not disallowed: they carry
 * `X-Robots-Tag: noindex` (Caddyfile), which a crawler can only read if
 * it may fetch them. `llms.txt` is linked in a comment (no robots.txt
 * directive exists for it).
 */
export function buildRobotsTxt(input: {
  readonly indexable: boolean;
  readonly sitemapUrl?: string;
  readonly llmsTxtUrl?: string;
}): string {
  const lines = ['User-agent: *', input.indexable ? 'Allow: /' : 'Disallow: /'];
  if (input.indexable && input.sitemapUrl) lines.push('', `Sitemap: ${input.sitemapUrl}`);
  if (input.indexable && input.llmsTxtUrl) {
    lines.push('', `# A summary of this site for AI assistants: ${input.llmsTxtUrl}`);
  }
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
 * Every language version of a page is a `<url>` of its own — the default
 * language's first, then the other's (`/ar/...`, or `/en/...` on an
 * Arabic-default site) — each listing the same alternates (always `en` then
 * `ar`, so every set is reciprocal) and `x-default` (the default language).
 * Google: "create a separate <url> element for each URL", each listing every
 * variant including itself. Before Nov 2026 only the default-language URL
 * was a `<loc>`, so the other language's pages were never submitted.
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
    const locales = [
      defaultLocale,
      ...PUBLIC_WEBSITE_LOCALES.filter((locale) => locale !== defaultLocale),
    ];
    return locales
      .map((locale) =>
        [
          '  <url>',
          `    <loc>${href(locale)}</loc>`,
          ...PUBLIC_WEBSITE_LOCALES.map(
            (alternate) =>
              `    <xhtml:link rel="alternate" hreflang="${alternate}" href="${href(alternate)}"/>`,
          ),
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${main}"/>`,
          `    <lastmod>${escapeXml(url.lastModified)}</lastmod>`,
          `    <changefreq>${url.changeFrequency}</changefreq>`,
          `    <priority>${url.priority.toFixed(1)}</priority>`,
          '  </url>',
        ].join('\n'),
      )
      .join('\n');
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...nodes,
    '</urlset>',
    '',
  ].join('\n');
}
