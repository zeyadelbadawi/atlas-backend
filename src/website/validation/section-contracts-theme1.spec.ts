/**
 * Theme 1 plan Phase 2 — section contract additions (§D.2).
 *
 * Additive and backward compatible: every v1 shape an existing Academy may
 * have stored parses to exactly itself, the four new types validate, and
 * image fields accept only what can safely become an `<img src>`.
 */
import {
  sectionInstanceArraySchema,
  sectionInstanceSchema,
} from './section-config.schemas';
import { classifyImageValue, isAllowedImageValue } from './image-value.util';

const lt = (en: string, ar = '') => ({ en, ar });
const base = { enabled: true, visibility: { desktop: true, tablet: true, mobile: true } };
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Shapes Academies stored before Phase 2 (§D.5's legacy-fixture list). */
const LEGACY_SECTIONS = [
  { ...base, id: 'h1', type: 'hero', config: { title: lt('Learn') } },
  {
    ...base,
    id: 'h2',
    type: 'hero',
    config: {
      title: lt('Learn', 'تعلم'),
      image: PNG,
      cta: { label: lt('Go'), pageId: 'p1' },
    },
  },
  { ...base, id: 't1', type: 'testimonials', config: { title: lt('Said'), items: [] } },
  {
    ...base,
    id: 's1',
    type: 'statistics',
    config: { items: [{ id: 'a', value: lt('500+'), label: lt('Students') }] },
  },
  {
    ...base,
    id: 'c1',
    type: 'cta',
    config: { title: lt('Join'), cta: { label: lt('Sign up') } },
  },
  { ...base, id: 'f1', type: 'faq', config: { items: [] } },
  {
    ...base,
    id: 'g1',
    type: 'gallery',
    config: { images: [{ id: 'i', image: 'https://cdn.example/x.webp' }] },
  },
  { ...base, id: 'fe', type: 'features', config: { items: [] } },
];

describe('Theme 1 section contracts — backward compatibility', () => {
  it('every legacy (v1) section parses to exactly itself', () => {
    for (const section of LEGACY_SECTIONS) {
      const parsed = sectionInstanceSchema.parse(section);
      expect(parsed).toEqual(section);
    }
  });

  it('a legacy bare-string field is still widened as before', () => {
    const parsed = sectionInstanceSchema.parse({
      ...base,
      id: 'x',
      type: 'about',
      config: { title: 'About', body: 'Body' },
    });
    expect(parsed.config).toMatchObject({ title: lt('About'), body: lt('Body') });
  });
});

describe('Theme 1 section contracts — new fields and types', () => {
  it('accepts the hero, features, faq, cta and testimonial extensions', () => {
    const sections = [
      {
        ...base,
        id: 'h',
        type: 'hero',
        config: {
          title: lt('Learn something new'),
          highlight: lt('something new'),
          highlights: [{ id: 'c1', label: lt('Certificates') }],
          showSearch: true,
          image: 'theme-asset:modern-education/home-hero',
        },
      },
      { ...base, id: 'fe', type: 'features', config: { items: [], layout: 'strip' } },
      {
        ...base,
        id: 'fq',
        type: 'faq',
        config: {
          items: [],
          maxItems: 4,
          cta: { label: lt('All questions'), pageId: 'p2' },
        },
      },
      {
        ...base,
        id: 'ct',
        type: 'cta',
        config: {
          title: lt('Ready?'),
          cta: { label: lt('Start') },
          secondaryCta: { label: lt('Contact us') },
          image: 'theme-asset:modern-education/home-cta',
          imageAlt: lt('A learner'),
        },
      },
      {
        ...base,
        id: 'ts',
        type: 'testimonials',
        config: {
          items: [
            { id: 'q', quote: lt('Great'), authorName: 'A. B.', rating: 5, sample: true },
          ],
        },
      },
    ];
    expect(sectionInstanceArraySchema.safeParse(sections).success).toBe(true);
  });

  it('accepts the four new section types', () => {
    const sections = [
      {
        ...base,
        id: 'ph',
        type: 'pageHeader',
        config: { title: lt('Courses'), search: 'courses' },
      },
      {
        ...base,
        id: 'cc',
        type: 'courseCategories',
        config: { title: lt('Explore'), maxItems: 8, showCounts: true },
      },
      {
        ...base,
        id: 'st',
        type: 'steps',
        config: {
          items: [
            { id: '1', title: lt('Sign up') },
            { id: '2', title: lt('Learn') },
          ],
        },
      },
      {
        ...base,
        id: 'fs',
        type: 'featureSplit',
        config: {
          title: lt('Why us'),
          imagePosition: 'end',
          items: [{ id: '1', title: lt('Mentors') }],
          image: 'theme-asset:modern-education/home-benefit',
        },
      },
    ];
    expect(sectionInstanceArraySchema.safeParse(sections).success).toBe(true);
  });

  it('enforces the new bounds', () => {
    const tooManySteps = {
      ...base,
      id: 'st',
      type: 'steps',
      config: {
        items: Array.from({ length: 7 }, (_, i) => ({
          id: String(i),
          title: lt('Step'),
        })),
      },
    };
    expect(sectionInstanceSchema.safeParse(tooManySteps).success).toBe(false);
    const oneCategory = {
      ...base,
      id: 'cc',
      type: 'courseCategories',
      config: { maxItems: 1, showCounts: true },
    };
    expect(sectionInstanceSchema.safeParse(oneCategory).success).toBe(false);
    const badRating = {
      ...base,
      id: 't',
      type: 'testimonials',
      config: { items: [{ id: 'q', quote: lt('x'), authorName: 'A', rating: 6 }] },
    };
    expect(sectionInstanceSchema.safeParse(badRating).success).toBe(false);
    const badSearch = {
      ...base,
      id: 'p',
      type: 'pageHeader',
      config: { title: lt('x'), search: 'everything' },
    };
    expect(sectionInstanceSchema.safeParse(badSearch).success).toBe(false);
  });
});

describe('image values', () => {
  it.each([
    ['', 'empty'],
    ['theme-asset:modern-education/home-hero', 'themeAsset'],
    ['https://media.example.com/a/b.webp', 'url'],
    ['http://localhost:9000/atlas-media-ci/x.png', 'url'],
    [PNG, 'legacyInline'],
  ])('accepts %s', (value, kind) => {
    expect(classifyImageValue(value)).toBe(kind);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,<script>',
    'blob:https://x/1',
    '/relative/path.png',
    'mailto:a@b.c',
    'theme-asset:../../etc/passwd',
    'theme-asset:Modern/HERO',
  ])('rejects %s', (value) => {
    expect(isAllowedImageValue(value)).toBe(false);
  });

  it('rejects a dangerous value in any image field', () => {
    const fields = [
      { type: 'hero', config: { title: lt('x'), image: 'javascript:x' } },
      { type: 'about', config: { title: lt('x'), body: lt('y'), image: 'javascript:x' } },
      { type: 'gallery', config: { images: [{ id: 'i', image: 'javascript:x' }] } },
      {
        type: 'testimonials',
        config: {
          items: [{ id: 'q', quote: lt('x'), authorName: 'A', avatar: 'javascript:x' }],
        },
      },
      {
        type: 'cta',
        config: { title: lt('x'), cta: { label: lt('y') }, image: 'javascript:x' },
      },
      { type: 'pageHeader', config: { title: lt('x'), image: 'javascript:x' } },
      {
        type: 'featureSplit',
        config: {
          title: lt('x'),
          imagePosition: 'start',
          items: [],
          image: 'javascript:x',
        },
      },
    ];
    for (const field of fields) {
      expect(
        sectionInstanceSchema.safeParse({ ...base, id: 'i', ...field }).success,
      ).toBe(false);
    }
  });

  it('still requires a gallery image', () => {
    const empty = {
      ...base,
      id: 'g',
      type: 'gallery',
      config: { images: [{ id: 'i', image: '' }] },
    };
    expect(sectionInstanceSchema.safeParse(empty).success).toBe(false);
  });
});
