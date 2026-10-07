import {
  planThemeRetirement,
  summariseThemeRetirement,
  websiteContentFingerprint,
  type ThemeRetirementWebsite,
} from './theme-retirement.util';
import { selectableWebsiteThemeKey } from '../constants/website.constants';

function website(
  overrides: Partial<ThemeRetirementWebsite> = {},
): ThemeRetirementWebsite {
  return {
    academyId: 'a1',
    organizationId: 'o1',
    academyName: 'Academy',
    academySlug: 'academy',
    themeKey: 'premium-academy',
    themeVersion: 1,
    configVersion: 4,
    templateKey: 'premium-academy',
    templateVersion: 1,
    status: 'published',
    brand: {
      primaryColor: '222 47% 25%',
      secondaryColor: '38 75% 48%',
      accentColor: '350 60% 45%',
      darkLogo: 'https://cdn.example/logo.png',
    },
    seo: { siteTitle: { en: 'A', ar: 'أ' } },
    navigation: [],
    header: {},
    footer: { groups: [], socialLinks: [] },
    pages: [
      {
        id: 'p1',
        slug: 'home',
        pageType: 'core',
        coreType: 'home',
        visible: true,
        seo: {},
        version: 3,
        sections: [
          { id: 's1', type: 'hero', config: { title: { en: 'Hi', ar: 'مرحبا' } } },
          { id: 's2', type: 'about', config: {} },
          { id: 's3', type: 'hero', config: {} },
        ],
      },
      {
        id: 'p2',
        slug: 'hidden',
        pageType: 'custom',
        coreType: null,
        visible: false,
        seo: {},
        version: 1,
        sections: [],
      },
    ],
    ...overrides,
  };
}

describe('theme retirement plan', () => {
  it('leaves a website on a selectable theme alone', () => {
    expect(planThemeRetirement(website({ themeKey: 'modern-education' }))).toBeNull();
    expect(planThemeRetirement(website({ themeKey: 'atelier' }))).toBeNull();
    expect(planThemeRetirement(website({ themeKey: 'manara' }))).toBeNull();
    expect(planThemeRetirement(website({ themeKey: 'riwaq' }))).toBeNull();
  });

  it('moves a retired theme to Theme 1 and reports what the website holds', () => {
    const entry = planThemeRetirement(website())!;
    expect(entry).toMatchObject({
      fromThemeKey: 'premium-academy',
      toThemeKey: 'modern-education',
      classification: 'retired',
      pages: 2,
      visiblePages: 1,
      sectionsByType: { hero: 2, about: 1 },
      unmappableSections: [],
      hiddenUntilContent: [],
      brand: {
        primaryColor: '222 47% 25%',
        hasDarkLogo: true,
        hasPalette: false,
      },
    });
  });

  it('lists sections Theme 1 hides until they have content', () => {
    const section = (id: string, type: string, config: unknown) => ({ id, type, config });
    const entry = planThemeRetirement(
      website({
        pages: [
          {
            id: 'p1',
            slug: 'home',
            pageType: 'core',
            coreType: 'home',
            visible: true,
            seo: {},
            version: 1,
            sections: [
              section('t-empty', 'testimonials', {
                title: { en: 'Voices', ar: 'أصوات' },
                items: [],
              }),
              section('t-sample', 'testimonials', {
                items: [{ quote: { en: 'Great', ar: 'رائع' }, sample: true }],
              }),
              section('t-real', 'testimonials', {
                items: [{ quote: { en: '', ar: 'رائع' }, sample: false }],
              }),
              section('g-empty', 'gallery', { images: [] }),
              section('g-full', 'gallery', { images: [{ src: 'x' }] }),
            ],
          },
        ],
      }),
    )!;
    expect(entry.hiddenUntilContent).toEqual([
      { pageSlug: 'home', sectionId: 't-empty', type: 'testimonials' },
      { pageSlug: 'home', sectionId: 't-sample', type: 'testimonials' },
      { pageSlug: 'home', sectionId: 'g-empty', type: 'gallery' },
    ]);
  });

  it('classifies a key no code knows as unknown', () => {
    expect(
      planThemeRetirement(website({ themeKey: 'from-the-future' }))?.classification,
    ).toBe('unknown');
  });

  it('flags sections no theme can render instead of dropping them', () => {
    const entry = planThemeRetirement(
      website({
        pages: [
          {
            id: 'p1',
            slug: 'home',
            pageType: 'core',
            coreType: 'home',
            visible: true,
            seo: {},
            version: 1,
            sections: [{ id: 's1', type: 'carousel' }, { id: 's2' }],
          },
          {
            id: 'p2',
            slug: 'broken',
            pageType: 'custom',
            coreType: null,
            visible: true,
            seo: {},
            version: 1,
            sections: { not: 'an array' },
          },
        ],
      }),
    )!;
    expect(entry.unmappableSections).toEqual([
      {
        pageSlug: 'home',
        sectionId: 's1',
        type: 'carousel',
        reason: 'unknownSectionType',
      },
      { pageSlug: 'home', sectionId: 's2', type: null, reason: 'unknownSectionType' },
      { pageSlug: 'broken', sectionId: null, type: null, reason: 'malformedSections' },
    ]);
  });

  it('fingerprints content, not the theme key, cache version or key order', () => {
    const base = website();
    const moved = { ...base, themeKey: 'modern-education', configVersion: 5 };
    expect(websiteContentFingerprint(moved)).toBe(websiteContentFingerprint(base));

    const reordered = {
      ...base,
      brand: {
        darkLogo: 'https://cdn.example/logo.png',
        accentColor: '350 60% 45%',
        secondaryColor: '38 75% 48%',
        primaryColor: '222 47% 25%',
      },
      pages: [...base.pages].reverse(),
    };
    expect(websiteContentFingerprint(reordered)).toBe(websiteContentFingerprint(base));

    for (const changed of [
      { ...base, brand: { ...(base.brand as object), primaryColor: '0 0% 0%' } },
      { ...base, brand: { ...(base.brand as object), darkLogo: undefined } },
      { ...base, templateKey: 'modern-education' },
      { ...base, pages: base.pages.slice(0, 1) },
      {
        ...base,
        pages: [{ ...base.pages[0], sections: [] }, base.pages[1]],
      },
    ]) {
      expect(websiteContentFingerprint(changed)).not.toBe(
        websiteContentFingerprint(base),
      );
    }
  });

  it('summarises the run', () => {
    const entries = [
      planThemeRetirement(website())!,
      planThemeRetirement(
        website({
          academyId: 'a2',
          themeKey: 'bold-creative',
          status: 'draft',
          brand: {},
        }),
      )!,
    ];
    expect(summariseThemeRetirement(7, entries)).toEqual({
      scanned: 7,
      toMove: 2,
      byTheme: { 'premium-academy': 1, 'bold-creative': 1 },
      published: 1,
      withUnmappableSections: 0,
      withSectionsHiddenUntilContent: 0,
      withoutStoredColours: 1,
    });
  });

  it('provisioning maps a retired key to its replacement and keeps a selectable one', () => {
    expect(selectableWebsiteThemeKey('corporate-learning')).toBe('modern-education');
    expect(selectableWebsiteThemeKey('modern-education')).toBe('modern-education');
    expect(selectableWebsiteThemeKey('atelier')).toBe('atelier');
    expect(selectableWebsiteThemeKey('manara')).toBe('manara');
    expect(selectableWebsiteThemeKey('riwaq')).toBe('riwaq');
  });
});
