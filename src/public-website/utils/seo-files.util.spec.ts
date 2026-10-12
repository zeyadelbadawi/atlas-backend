import {
  buildRobotsTxt,
  buildSitemapUrls,
  buildSitemapXml,
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
    expect(publicPagePath(page({ pageType: 'custom', slug: 'pricing' }))).toBe('/pricing');
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
