/**
 * B3 — URL scheme rules for Platform Owner content rendered on the public
 * marketing site: stored button/image/checklist URLs, and every link and
 * image inside blog markdown.
 */
import {
  findUnsafeMarkdownUrls,
  isSafeHttpsOrSiteRelativeUrl,
  isSafeMarkdownImage,
  isSafeMarkdownLink,
  normalizeUrlForSchemeCheck,
} from './safe-url.util';

describe('isSafeHttpsOrSiteRelativeUrl (ctaUrl, imageUrl, coverImage.url, linkUrl)', () => {
  it.each([
    'https://atlas.example/pricing',
    'https://atlas.example/a?b=1&c=2#d',
    '/pricing',
    '/marketing-assets/blog/cover.webp',
    '/api/v1/public/media/platform/blog/0f0c7f84-0b8e-4bb3-8f9e-1f2b3c4d5e6f.webp',
  ])('accepts %s', (url) => {
    expect(isSafeHttpsOrSiteRelativeUrl(url)).toBe(true);
  });

  it.each([
    'http://atlas.example/',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:image/png;base64,AAAA',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    '/\\evil.example',
    'pricing',
    'https://user:pass@atlas.example/',
    ' https://atlas.example/',
    'https://atlas.example/\nx',
    'java&#115;cript:alert(1)',
    'https:',
    '',
    `https://atlas.example/${'a'.repeat(2001)}`,
  ])('refuses %j', (url) => {
    expect(isSafeHttpsOrSiteRelativeUrl(url)).toBe(false);
  });

  it('refuses non-strings', () => {
    expect(isSafeHttpsOrSiteRelativeUrl(null)).toBe(false);
    expect(isSafeHttpsOrSiteRelativeUrl(42)).toBe(false);
  });
});

describe('normalizeUrlForSchemeCheck', () => {
  it('decodes character references and drops whitespace and control characters', () => {
    expect(normalizeUrlForSchemeCheck('java&#x73;cript&colon;x')).toBe('javascript:x');
    expect(normalizeUrlForSchemeCheck('java\tscr\nipt:x')).toBe('javascript:x');
    expect(normalizeUrlForSchemeCheck('&#106;avascript:x')).toBe('javascript:x');
  });
});

describe('markdown links and images', () => {
  it('links: http(s), mailto, fragments and site paths only', () => {
    for (const ok of [
      'https://a.example',
      'http://a.example',
      'mailto:hi@a.example',
      '#faq',
      '/pricing',
      'pricing',
      '',
    ]) {
      expect(isSafeMarkdownLink(ok)).toBe(true);
    }
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.example',
      'tel:123',
    ]) {
      expect(isSafeMarkdownLink(bad)).toBe(false);
    }
  });

  it('images: https or a site path only', () => {
    expect(isSafeMarkdownImage('https://cdn.example/a.webp')).toBe(true);
    expect(isSafeMarkdownImage('/marketing-assets/blog/a.webp')).toBe(true);
    for (const bad of [
      'http://cdn.example/a.png',
      'data:image/png;base64,AAAA',
      'a.png',
      '//cdn.example/a.png',
      '',
    ]) {
      expect(isSafeMarkdownImage(bad)).toBe(false);
    }
  });

  it('finds nothing in a clean post', () => {
    const body = [
      '# Protecting your courses',
      'See [pricing](/pricing) and [our guide](https://atlas.example/guide "Guide").',
      '![A cover](/marketing-assets/blog/cover.webp)',
      'Mail [support](mailto:support@atlas.example). Jump to [FAQ](#faq).',
      '[ref]: https://atlas.example/ref',
      '<https://atlas.example/auto>',
      'Text with (parentheses) and [brackets] only.',
    ].join('\n');
    expect(findUnsafeMarkdownUrls(body)).toEqual([]);
  });

  it.each([
    ['inline link', '[x](javascript:alert(1))', 'link'],
    ['link with title', '[x](javascript:alert(1) "t")', 'link'],
    ['angle link', '[x](<javascript:alert(1)>)', 'link'],
    ['entity-encoded link', '[x](javascript&#58;alert(1))', 'link'],
    ['data link', '[x](data:text/html;base64,PHNjcmlwdD4=)', 'link'],
    ['vbscript link', '[x](vbscript:msgbox)', 'link'],
    ['http image', '![x](http://cdn.example/a.png)', 'image'],
    ['data image', '![x](data:image/png;base64,AAAA)', 'image'],
    ['image nested in a link', '[![x](data:image/png;base64,AAAA)](/ok)', 'image'],
    ['reference definition', '[ref]: javascript:alert(1)', 'link'],
    ['autolink', '<javascript:alert(1)>', 'link'],
    ['raw html href', '<a href="javascript:alert(1)">x</a>', 'link'],
    ['raw html src', "<img src='data:image/png;base64,AAAA'>", 'image'],
  ])('refuses a %s', (_label, body, kind) => {
    const found = findUnsafeMarkdownUrls(body);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].kind).toBe(kind);
  });

  it('stays bounded on hostile input', () => {
    const started = Date.now();
    findUnsafeMarkdownUrls('['.repeat(60_000));
    findUnsafeMarkdownUrls('[a]('.repeat(15_000));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
