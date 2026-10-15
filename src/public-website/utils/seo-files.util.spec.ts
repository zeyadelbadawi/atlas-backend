import {
  buildRobotsTxt,
  buildSitemapUrls,
  buildSitemapXml,
  localizedSitePath,
  publicPagePath,
  type SeoFilePage,
} from './seo-files.util';

const page = (over: Partial<SeoFilePage>): SeoFilePage => ({
  pageType: 'core',
  coreType: null,
  slug: 'x',
  visible: true,
  updatedAt: '2026-10-01T00:00:00.000Z',
  seo: {},
  ...over,
});

describe('publicPagePath', () => {
  it('matches the public router', () => {
    expect(publicPagePath(page({ coreType: 'home', slug: 'home' }))).toBe('/');
    expect(publicPagePath(page({ coreType: 'courses' }))).toBe('/courses');
    expect(publicPagePath(page({ coreType: 'courseDetails' }))).toBeUndefined();
    expect(publicPagePath(page({ pageType: 'custom', slug: 'pricing' }))).toBe(
      '/pricing',
    );
  });
});

describe('buildSitemapUrls', () => {
  it('lists visible, indexable pages and published public courses only', () => {
    const urls = buildSitemapUrls(
      [
        page({ coreType: 'home', slug: 'home' }),
        page({ coreType: 'about', visible: false }),
        page({ pageType: 'custom', slug: 'secret', seo: { indexable: false } }),
        page({ coreType: 'courseDetails' }),
      ],
      [
        { slug: 'algebra', status: 'published', visibility: 'public', updatedAt: 't1' },
        { slug: 'draft', status: 'draft', visibility: 'public', updatedAt: 't2' },
        { slug: 'private', status: 'published', visibility: 'private', updatedAt: 't3' },
      ],
    );
    expect(urls.map((u) => u.path)).toEqual(['/', '/courses/algebra']);
  });
});

describe('buildRobotsTxt', () => {
  it('allows and links the sitemap when indexable', () => {
    expect(
      buildRobotsTxt({ indexable: true, sitemapUrl: 'https://a.example/sitemap.xml' }),
    ).toBe('User-agent: *\nAllow: /\n\nSitemap: https://a.example/sitemap.xml\n');
  });

  it('disallows everything and links no sitemap when not indexable', () => {
    expect(
      buildRobotsTxt({ indexable: false, sitemapUrl: 'https://a.example/sitemap.xml' }),
    ).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('buildSitemapXml', () => {
  it('writes each URL with its Arabic alternate and escapes values', () => {
    const xml = buildSitemapXml(
      [{ path: '/', lastModified: 't', changeFrequency: 'weekly', priority: 1 }],
      'https://a.example',
    );
    expect(xml).toContain('<loc>https://a.example/</loc>');
    expect(xml).toContain('hreflang="ar" href="https://a.example/ar"');
    expect(xml).toContain('hreflang="x-default" href="https://a.example/"');
    expect(xml).toContain('<priority>1.0</priority>');
    expect(
      buildSitemapXml(
        [{ path: '/a&b', lastModified: 't', changeFrequency: 'monthly', priority: 0.6 }],
        'https://a.example',
      ),
    ).toContain('<loc>https://a.example/a&amp;b</loc>');
  });
});

describe('buildSitemapXml — B0-WEB-02 default locale', () => {
  const urls = [
    { path: '/', lastModified: 't0', changeFrequency: 'weekly', priority: 1 },
    { path: '/about', lastModified: 't1', changeFrequency: 'monthly', priority: 0.6 },
  ] as const;

  // The exact bytes an English-default site was served before B0-WEB-02.
  const ENGLISH_DEFAULT = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    '  <url>',
    '    <loc>https://a.example/</loc>',
    '    <xhtml:link rel="alternate" hreflang="en" href="https://a.example/"/>',
    '    <xhtml:link rel="alternate" hreflang="ar" href="https://a.example/ar"/>',
    '    <xhtml:link rel="alternate" hreflang="x-default" href="https://a.example/"/>',
    '    <lastmod>t0</lastmod>',
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '  <url>',
    '    <loc>https://a.example/about</loc>',
    '    <xhtml:link rel="alternate" hreflang="en" href="https://a.example/about"/>',
    '    <xhtml:link rel="alternate" hreflang="ar" href="https://a.example/ar/about"/>',
    '    <xhtml:link rel="alternate" hreflang="x-default" href="https://a.example/about"/>',
    '    <lastmod>t1</lastmod>',
    '    <changefreq>monthly</changefreq>',
    '    <priority>0.6</priority>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');

  it('an English-default site is byte-identical, with or without the argument', () => {
    expect(buildSitemapXml(urls, 'https://a.example')).toBe(ENGLISH_DEFAULT);
    expect(buildSitemapXml(urls, 'https://a.example', 'en')).toBe(ENGLISH_DEFAULT);
  });

  it('an Arabic-default site lists Arabic at the root, English under /en, x-default Arabic', () => {
    const xml = buildSitemapXml(urls, 'https://a.example', 'ar');
    expect(xml).toContain('<loc>https://a.example/</loc>');
    expect(xml).toContain('hreflang="ar" href="https://a.example/"');
    expect(xml).toContain('hreflang="en" href="https://a.example/en"');
    expect(xml).toContain('hreflang="x-default" href="https://a.example/"');
    expect(xml).toContain('<loc>https://a.example/about</loc>');
    expect(xml).toContain('hreflang="en" href="https://a.example/en/about"');
    expect(xml).toContain('hreflang="x-default" href="https://a.example/about"');
    expect(xml).not.toContain('/ar');
  });

  it('every page’s alternates are reciprocal: the same set from each language’s URL', () => {
    for (const defaultLocale of ['en', 'ar'] as const) {
      const xml = buildSitemapXml(urls, 'https://a.example', defaultLocale);
      const blocks = xml.split('<url>').slice(1);
      for (const block of blocks) {
        const alternates = [...block.matchAll(/hreflang="(en|ar)" href="([^"]+)"/g)].map(
          (m) => [m[1], m[2]] as const,
        );
        expect(alternates.map(([locale]) => locale)).toEqual(['en', 'ar']);
        // Both language URLs are distinct and one of them is the <loc>.
        const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
        expect(new Set(alternates.map(([, href]) => href)).size).toBe(2);
        expect(alternates.find(([locale]) => locale === defaultLocale)?.[1]).toBe(loc);
      }
    }
  });
});

describe('localizedSitePath', () => {
  it('prefixes only the non-default language, the root without a trailing slash', () => {
    expect(localizedSitePath('/', 'ar')).toBe('/ar');
    expect(localizedSitePath('/about', 'ar')).toBe('/ar/about');
    expect(localizedSitePath('/about', 'en')).toBe('/about');
    expect(localizedSitePath('/', 'en', 'ar')).toBe('/en');
    expect(localizedSitePath('/about', 'en', 'ar')).toBe('/en/about');
    expect(localizedSitePath('/about', 'ar', 'ar')).toBe('/about');
  });
});
