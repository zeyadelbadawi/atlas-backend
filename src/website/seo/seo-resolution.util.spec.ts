import { resolveCourseSeo, resolvePageSeo } from './seo-resolution.util';
import type { WebsiteConfigurationSeoInput, WebsitePageInput } from './seo.types';

const fallback = {
  title: 'Acme Academy',
  description: 'Acme Academy fallback description',
};

function page(
  overrides: Partial<WebsitePageInput['seo']> = {},
  visible = true,
): WebsitePageInput {
  return { slug: 'about', visible, seo: overrides };
}

function config(
  overrides: Partial<WebsiteConfigurationSeoInput['seo']> = {},
): WebsiteConfigurationSeoInput {
  return { seo: overrides };
}

describe('resolvePageSeo — precedence hierarchy', () => {
  it('Page Override wins over Global and Fallback when all three are present', () => {
    const result = resolvePageSeo(
      page({ metaTitle: 'Page Title', metaDescription: 'Page Description' }),
      config({ metaTitle: 'Global Title', metaDescription: 'Global Description' }),
      fallback,
    );
    expect(result.title).toBe('Page Title');
    expect(result.titleSource).toBe('override');
    expect(result.description).toBe('Page Description');
    expect(result.descriptionSource).toBe('override');
  });

  it('Global wins over Fallback when no Page Override is present', () => {
    const result = resolvePageSeo(
      page(),
      config({ metaTitle: 'Global Title', metaDescription: 'Global Description' }),
      fallback,
    );
    expect(result.title).toBe('Global Title');
    expect(result.titleSource).toBe('global');
    expect(result.description).toBe('Global Description');
    expect(result.descriptionSource).toBe('global');
  });

  it('Fallback is used when neither Page Override nor Global is present', () => {
    const result = resolvePageSeo(page(), config(), fallback);
    expect(result.title).toBe(fallback.title);
    expect(result.titleSource).toBe('fallback');
    expect(result.description).toBe(fallback.description);
    expect(result.descriptionSource).toBe('fallback');
  });

  it('resolves title and description INDEPENDENTLY (field-level fallback, not object-level)', () => {
    // Only metaTitle is overridden at the page level; metaDescription
    // must still fall through to Global, not the page's own blank value.
    const result = resolvePageSeo(
      page({ metaTitle: 'Page Title' }),
      config({ metaTitle: 'Global Title', metaDescription: 'Global Description' }),
      fallback,
    );
    expect(result.title).toBe('Page Title');
    expect(result.titleSource).toBe('override');
    expect(result.description).toBe('Global Description');
    expect(result.descriptionSource).toBe('global');
  });

  it('ogTitle/ogDescription fall back to the ALREADY-RESOLVED title/description, not directly to Global', () => {
    const result = resolvePageSeo(
      page({ metaTitle: 'Page Title' }),
      config({ metaDescription: 'Global Description' }),
      fallback,
    );
    // ogTitle has no override anywhere, so it takes the resolved title.
    expect(result.ogTitle).toBe('Page Title');
    expect(result.ogDescription).toBe('Global Description');
  });

  it('ogTitle uses its OWN override when present, distinct from title', () => {
    const result = resolvePageSeo(
      page({ metaTitle: 'Page Title', ogTitle: 'Custom OG Title' }),
      config(),
      fallback,
    );
    expect(result.title).toBe('Page Title');
    expect(result.ogTitle).toBe('Custom OG Title');
  });

  it('ogImage is a two-level fallback only (Page → Global), with no system default', () => {
    const withNeither = resolvePageSeo(page(), config(), fallback);
    expect(withNeither.ogImage).toBeUndefined();

    const withGlobal = resolvePageSeo(
      page(),
      config({ ogImage: 'https://x/global.png' }),
      fallback,
    );
    expect(withGlobal.ogImage).toBe('https://x/global.png');

    const withOverride = resolvePageSeo(
      page({ ogImage: 'https://x/page.png' }),
      config({ ogImage: 'https://x/global.png' }),
      fallback,
    );
    expect(withOverride.ogImage).toBe('https://x/page.png');
  });

  it('canonicalPath falls back to `/${page.slug}` when no override is set', () => {
    const result = resolvePageSeo(page(), config(), fallback);
    expect(result.canonicalPath).toBe('/about');
  });

  it('canonicalPath uses the explicit override when set', () => {
    const result = resolvePageSeo(
      page({ canonicalPath: '/custom-path' }),
      config(),
      fallback,
    );
    expect(result.canonicalPath).toBe('/custom-path');
  });

  it('indexable defaults to true when nothing specifies otherwise', () => {
    const result = resolvePageSeo(page(), config(), fallback);
    expect(result.indexable).toBe(true);
  });

  it('indexable respects an explicit `false` page override (boolean `??`, not `||`)', () => {
    const result = resolvePageSeo(page({ indexable: false }), config(), fallback);
    expect(result.indexable).toBe(false);
  });

  it('indexable falls through to the Global robotsIndexable when the page has no explicit value', () => {
    const result = resolvePageSeo(page(), config({ robotsIndexable: false }), fallback);
    expect(result.indexable).toBe(false);
  });

  it('a HIDDEN page is never indexable, regardless of any override', () => {
    const result = resolvePageSeo(page({ indexable: true }, false), config(), fallback);
    expect(result.indexable).toBe(false);
  });

  it('produces deterministic output for identical input', () => {
    const a = resolvePageSeo(page({ metaTitle: 'X' }), config(), fallback);
    const b = resolvePageSeo(page({ metaTitle: 'X' }), config(), fallback);
    expect(a).toEqual(b);
  });
});

describe('resolveCourseSeo', () => {
  const baseCourse = {
    title: 'Intro to Testing',
    slug: 'intro-to-testing',
    status: 'published',
    visibility: 'public',
  };

  it('uses the course title as an override, falling back only if genuinely blank', () => {
    const result = resolveCourseSeo(baseCourse, config(), fallback);
    expect(result.title).toBe('Intro to Testing');
    expect(result.titleSource).toBe('override');
  });

  it('falls back to shortDescription over description when both are present', () => {
    const result = resolveCourseSeo(
      { ...baseCourse, shortDescription: 'Short', description: 'Long' },
      config(),
      fallback,
    );
    expect(result.description).toBe('Short');
  });

  it('falls back to description when shortDescription is absent', () => {
    const result = resolveCourseSeo(
      { ...baseCourse, description: 'Long description' },
      config(),
      fallback,
    );
    expect(result.description).toBe('Long description');
  });

  it('falls back to Global metaDescription when the course has neither', () => {
    const result = resolveCourseSeo(
      baseCourse,
      config({ metaDescription: 'Global' }),
      fallback,
    );
    expect(result.description).toBe('Global');
  });

  it('falls back to the caller-supplied fallback when nothing else is present', () => {
    const result = resolveCourseSeo(baseCourse, config(), fallback);
    expect(result.description).toBe(fallback.description);
    expect(result.descriptionSource).toBe('fallback');
  });

  it('canonicalPath is always `/courses/{slug}`', () => {
    const result = resolveCourseSeo(baseCourse, config(), fallback);
    expect(result.canonicalPath).toBe('/courses/intro-to-testing');
  });

  it('is indexable only when status=published AND visibility=public', () => {
    expect(resolveCourseSeo(baseCourse, config(), fallback).indexable).toBe(true);
    expect(
      resolveCourseSeo({ ...baseCourse, status: 'draft' }, config(), fallback).indexable,
    ).toBe(false);
    expect(
      resolveCourseSeo({ ...baseCourse, visibility: 'private' }, config(), fallback)
        .indexable,
    ).toBe(false);
  });

  it('a publicly reachable course still respects Global robotsIndexable=false', () => {
    const result = resolveCourseSeo(
      baseCourse,
      config({ robotsIndexable: false }),
      fallback,
    );
    expect(result.indexable).toBe(false);
  });

  it('ogImage falls back from course thumbnail to Global ogImage', () => {
    const withThumbnail = resolveCourseSeo(
      { ...baseCourse, thumbnail: 'https://x/course.png' },
      config({ ogImage: 'https://x/global.png' }),
      fallback,
    );
    expect(withThumbnail.ogImage).toBe('https://x/course.png');

    const withoutThumbnail = resolveCourseSeo(
      baseCourse,
      config({ ogImage: 'https://x/global.png' }),
      fallback,
    );
    expect(withoutThumbnail.ogImage).toBe('https://x/global.png');
  });
});
