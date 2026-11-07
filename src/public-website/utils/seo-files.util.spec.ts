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

describe('buildSitemapUrls — lastmod', () => {
  it('dates a page by the later of its own change and the site’s last publish', () => {
    const urls = buildSitemapUrls(
      [
        page({ coreType: 'home', slug: 'home', updatedAt: '2026-10-01T00:00:00.000Z' }),
        page({ coreType: 'about', slug: 'about', updatedAt: '2026-12-01T00:00:00.000Z' }),
      ],
      [
        {
          slug: 'c',
          status: 'published',
          visibility: 'public',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      '2026-11-01T00:00:00.000Z',
    );
    expect(urls.map((u) => u.lastModified)).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
      // A course's own change only: a site publish does not change it.
      '2026-09-01T00:00:00.000Z',
    ]);
  });
});

describe('buildRobotsTxt', () => {
  it('names llms.txt in a comment only when indexable', () => {
    expect(
      buildRobotsTxt({
        indexable: true,
        sitemapUrl: 'https://a.example/sitemap.xml',
        llmsTxtUrl: 'https://a.example/llms.txt',
      }),
    ).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://a.example/sitemap.xml\n\n# A summary of this site for AI assistants: https://a.example/llms.txt\n',
    );
    expect(
      buildRobotsTxt({ indexable: false, llmsTxtUrl: 'https://a.example/llms.txt' }),
    ).toBe('User-agent: *\nDisallow: /\n');
  });

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

  const entry = (
    loc: string,
    en: string,
    ar: string,
    xDefault: string,
    t: string,
    freq: string,
    priority: string,
  ) => [
    '  <url>',
    `    <loc>${loc}</loc>`,
    `    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>`,
    `    <xhtml:link rel="alternate" hreflang="ar" href="${ar}"/>`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${xDefault}"/>`,
    `    <lastmod>${t}</lastmod>`,
    `    <changefreq>${freq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ];
  // Every language version is a <url> of its own (Google: one <url> per
  // URL, each listing all variants) — the default language's first.
  const ENGLISH_DEFAULT = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entry(
      'https://a.example/',
      'https://a.example/',
      'https://a.example/ar',
      'https://a.example/',
      't0',
      'weekly',
      '1.0',
    ),
    ...entry(
      'https://a.example/ar',
      'https://a.example/',
      'https://a.example/ar',
      'https://a.example/',
      't0',
      'weekly',
      '1.0',
    ),
    ...entry(
      'https://a.example/about',
      'https://a.example/about',
      'https://a.example/ar/about',
      'https://a.example/about',
      't1',
      'monthly',
      '0.6',
    ),
    ...entry(
      'https://a.example/ar/about',
      'https://a.example/about',
      'https://a.example/ar/about',
      'https://a.example/about',
      't1',
      'monthly',
      '0.6',
    ),
    '</urlset>',
    '',
  ].join('\n');

  it('an English-default site lists both languages, with or without the argument', () => {
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
    expect(xml).toContain('<loc>https://a.example/en/about</loc>');
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
        expect(alternates.map(([, href]) => href)).toContain(loc);
        // x-default is always the default language's URL.
        const xDefault = /hreflang="x-default" href="([^"]+)"/.exec(block)?.[1];
        expect(xDefault).toBe(
          alternates.find(([locale]) => locale === defaultLocale)?.[1],
        );
      }
      // Every language URL of every page is submitted.
      expect(blocks).toHaveLength(urls.length * 2);
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
