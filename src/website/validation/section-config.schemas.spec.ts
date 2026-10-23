import {
  aboutSectionSchema,
  contactSectionSchema,
  courseCatalogSectionSchema,
  featuredCoursesSectionSchema,
  featuresSectionSchema,
  gallerySectionSchema,
  heroSectionSchema,
  sectionInstanceArraySchema,
  sectionInstanceSchema,
  statisticsSectionSchema,
  stepsSectionSchema,
  testimonialsSectionSchema,
} from './section-config.schemas';
import type { BadRequestException } from '@nestjs/common';
import { parseOrThrow } from '../../common/validation/zod-violations.util';
import {
  MAX_CTA_LABEL_LENGTH,
  MAX_HERO_DESCRIPTION_LENGTH,
  MAX_HERO_EYEBROW_LENGTH,
  MAX_HERO_SUBTITLE_LENGTH,
  MAX_HERO_TITLE_LENGTH,
  MAX_SHORT_TEXT,
  MAX_STATISTIC_LABEL_LENGTH,
  MAX_STATISTICS_TITLE_LENGTH,
  MAX_STEP_DESCRIPTION_LENGTH,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEPS_DESCRIPTION_LENGTH,
  MAX_STEPS_TITLE_LENGTH,
} from '../constants/website.constants';

const visibility = { desktop: true, tablet: true, mobile: true };

function heroInstance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'section-1',
    type: 'hero',
    enabled: true,
    visibility,
    config: { title: 'Welcome' },
    ...overrides,
  };
}

describe('sectionInstanceSchema — discriminated union boundary', () => {
  it('accepts a well-formed hero section', () => {
    expect(sectionInstanceSchema.safeParse(heroInstance()).success).toBe(true);
  });

  it('rejects an unregistered section type', () => {
    const result = sectionInstanceSchema.safeParse(
      heroInstance({ type: 'notARealSectionType', config: {} }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a type/config mismatch (a hero `type` carrying an `about` shaped `config`)', () => {
    // `about` requires `body` (missing) and has no `title`-only-valid hero
    // fields — a payload shaped for one section type must never validate
    // against another's config, even when both are "close enough."
    const result = sectionInstanceSchema.safeParse(
      heroInstance({ config: { image: 'https://example.com/x.png' } }),
    );
    // hero.title is required — an `about`-shaped config with no `title` fails.
    expect(result.success).toBe(false);
  });

  it('rejects a section missing its required `id`', () => {
    const instance = heroInstance() as Record<string, unknown>;
    delete instance.id;
    expect(sectionInstanceSchema.safeParse(instance).success).toBe(false);
  });

  it('keeps a section’s design (CMS phase 3), named choices only', () => {
    const design = {
      background: 'dark',
      spacing: 'compact',
      spacingMobile: 'spacious',
      align: 'center',
      width: 'wide',
      reverseOnMobile: true,
    };
    const result = sectionInstanceSchema.safeParse(heroInstance({ design }));
    expect(result.success).toBe(true);
    expect(result.success && result.data.design).toEqual(design);
  });

  it('a section without a design is still valid', () => {
    const result = sectionInstanceSchema.safeParse(heroInstance());
    expect(result.success && result.data.design).toBeUndefined();
  });

  it.each([
    [{ background: '#ff0000' }],
    [{ spacing: '12px' }],
    [{ align: 'right' }],
    [{ width: 'full-bleed' }],
    [{ reverseOnMobile: 'yes' }],
  ])('refuses a design value outside the named choices: %o', (design) => {
    expect(sectionInstanceSchema.safeParse(heroInstance({ design })).success).toBe(false);
  });

  it('rejects a section with a non-boolean `enabled`', () => {
    const result = sectionInstanceSchema.safeParse(heroInstance({ enabled: 'yes' }));
    expect(result.success).toBe(false);
  });

  it('rejects a malformed `visibility` (missing a breakpoint key)', () => {
    const result = sectionInstanceSchema.safeParse(
      heroInstance({ visibility: { desktop: true, tablet: true } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a completely empty object', () => {
    expect(sectionInstanceSchema.safeParse({}).success).toBe(false);
  });

  it('rejects `null`/arrays/primitives outright', () => {
    expect(sectionInstanceSchema.safeParse(null).success).toBe(false);
    expect(sectionInstanceSchema.safeParse([]).success).toBe(false);
    expect(sectionInstanceSchema.safeParse('hero').success).toBe(false);
  });
});

describe('sectionInstanceArraySchema — page-level composition', () => {
  it('accepts an empty page (no sections)', () => {
    expect(sectionInstanceArraySchema.safeParse([]).success).toBe(true);
  });

  it('accepts multiple distinct, valid sections', () => {
    const result = sectionInstanceArraySchema.safeParse([
      heroInstance({ id: 'a' }),
      heroInstance({ id: 'b' }),
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects duplicate section ids within one page', () => {
    const result = sectionInstanceArraySchema.safeParse([
      heroInstance({ id: 'dup' }),
      heroInstance({ id: 'dup' }),
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts the CMS phase 3d sections on a page (logos, map, schedule, results)', () => {
    const lt = (en: string) => ({ en, ar: '' });
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 'l',
        type: 'logos',
        enabled: true,
        visibility,
        config: { title: lt('Partners'), items: [] },
      },
      {
        id: 'm',
        type: 'map',
        enabled: true,
        visibility,
        config: { title: lt('Visit us'), address: lt('12 Tahrir St.') },
      },
      {
        id: 's',
        type: 'schedule',
        enabled: true,
        visibility,
        config: {
          title: lt('Timetable'),
          items: [
            { id: 'r', day: 'fri', start: '09:00', end: '10:30', title: lt('Physics') },
          ],
        },
      },
      {
        id: 'r',
        type: 'results',
        enabled: true,
        visibility,
        config: {
          title: lt('Top students'),
          items: [{ id: 'x', studentName: 'Omar', result: lt('First in Egypt') }],
        },
      },
    ]);
    expect(result.success).toBe(true);
  });

  it('points a schedule row ending before it starts at its end time', () => {
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 's',
        type: 'schedule',
        enabled: true,
        visibility,
        config: {
          title: { en: 'Timetable', ar: '' },
          items: [
            {
              id: 'r',
              day: 'sat',
              start: '18:00',
              end: '17:00',
              title: { en: 'Math', ar: '' },
            },
          ],
        },
      },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      message: 'validation:endAfterStart',
      path: [0, 'config', 'items', 0, 'end'],
    });
  });

  it('accepts the CMS phase 3d batch D sections on a page (timeline, video reviews, downloads, certificates)', () => {
    const lt = (en: string) => ({ en, ar: '' });
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 't',
        type: 'timeline',
        enabled: true,
        visibility,
        config: {
          title: lt('Your path'),
          items: [
            { id: 'm', title: lt('Term 1'), period: lt('Sept–Oct'), icon: 'BookOpen' },
          ],
        },
      },
      {
        id: 'v',
        type: 'videoTestimonials',
        enabled: true,
        visibility,
        config: {
          title: lt('Reviews'),
          items: [
            {
              id: 'r',
              videoId: 'https://youtu.be/dQw4w9WgXcQ',
              name: 'Mona',
              role: lt('Parent'),
            },
          ],
        },
      },
      {
        id: 'd',
        type: 'downloads',
        enabled: true,
        visibility,
        config: {
          title: lt('Notes'),
          items: [
            {
              id: 'f',
              title: lt('Sheet'),
              url: '/api/v1/public/media/academies/a/b.pdf',
            },
          ],
        },
      },
      {
        id: 'c',
        type: 'certificates',
        enabled: true,
        visibility,
        config: {
          title: lt('Certificates'),
          items: [
            {
              id: 'x',
              image: '/api/v1/public/media/academies/a/c.png',
              title: lt('ISO 9001'),
            },
          ],
        },
      },
    ]);
    expect(result.success).toBe(true);
    const sections = result.data as { config: { items: Record<string, unknown>[] } }[];
    // The video link is stored as its id, like the video section's.
    expect(sections[1].config.items[0].videoId).toBe('dQw4w9WgXcQ');
  });

  it('names an unsafe download link and a malformed certificate year', () => {
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 'd',
        type: 'downloads',
        enabled: true,
        visibility,
        config: {
          title: { en: 'Notes', ar: '' },
          items: [
            { id: 'f', title: { en: 'Sheet', ar: '' }, url: 'javascript:alert(1)' },
          ],
        },
      },
      {
        id: 'c',
        type: 'certificates',
        enabled: true,
        visibility,
        config: {
          title: { en: 'Certificates', ar: '' },
          items: [
            {
              id: 'x',
              image: '/api/v1/public/media/academies/a/c.png',
              title: { en: 'ISO', ar: '' },
              year: '20255',
            },
          ],
        },
      },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'validation:invalidDownloadLink',
          path: [0, 'config', 'items', 0, 'url'],
        }),
        expect.objectContaining({
          message: 'validation:invalidYear',
          path: [1, 'config', 'items', 0, 'year'],
        }),
      ]),
    );
  });

  it('rejects the whole array if any one section is malformed', () => {
    const result = sectionInstanceArraySchema.safeParse([
      heroInstance({ id: 'a' }),
      { id: 'b', type: 'hero', enabled: true, visibility, config: {} },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('heroSectionSchema', () => {
  it('rejects a missing required `title`', () => {
    expect(heroSectionSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a `title` over the max-length bound', () => {
    const result = heroSectionSchema.safeParse({ title: 'x'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('accepts a title-only payload (every other field optional)', () => {
    expect(heroSectionSchema.safeParse({ title: 'Welcome' }).success).toBe(true);
  });

  it('rejects a CTA `url` using a disallowed scheme (stored-XSS boundary)', () => {
    const result = heroSectionSchema.safeParse({
      title: 'Welcome',
      cta: { label: 'Go', url: 'javascript:alert(1)' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a `data:` URL as a CTA target', () => {
    const result = heroSectionSchema.safeParse({
      title: 'Welcome',
      cta: { label: 'Go', url: 'data:text/html,<script>alert(1)</script>' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an `https:` CTA URL', () => {
    const result = heroSectionSchema.safeParse({
      title: 'Welcome',
      cta: { label: 'Go', url: 'https://example.com' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an arbitrary long `title` string containing an inert `<script>` tag as plain text (never executed, never HTML-parsed — a text field, not a markup sink)', () => {
    const result = heroSectionSchema.safeParse({ title: '<script>alert(1)</script>' });
    expect(result.success).toBe(true);
  });
});

describe('aboutSectionSchema', () => {
  it('rejects a missing required `body`', () => {
    expect(aboutSectionSchema.safeParse({ title: 'About us' }).success).toBe(false);
  });
});

// P64 Phase 4 §E.1 — the backend must accept exactly the shape the frontend
// `courseCatalogSectionSchema` produces, or an Owner cannot save a page
// containing the catalog section.
describe('courseCatalogSectionSchema', () => {
  const base = {
    title: 'All courses',
    pageSize: 12,
    defaultSort: 'newest',
    showSearch: true,
    showLevelFilter: true,
    showPricingFilter: true,
    showSort: true,
  };

  it('accepts the frontend default config', () => {
    expect(courseCatalogSectionSchema.safeParse(base).success).toBe(true);
  });

  it('accepts every sort value the frontend offers', () => {
    for (const defaultSort of ['newest', 'title', 'priceAsc', 'priceDesc']) {
      expect(courseCatalogSectionSchema.safeParse({ ...base, defaultSort }).success).toBe(
        true,
      );
    }
  });

  it('rejects an unknown sort value', () => {
    expect(
      courseCatalogSectionSchema.safeParse({ ...base, defaultSort: 'random' }).success,
    ).toBe(false);
  });

  it('bounds pageSize to 6–48', () => {
    expect(courseCatalogSectionSchema.safeParse({ ...base, pageSize: 5 }).success).toBe(
      false,
    );
    expect(courseCatalogSectionSchema.safeParse({ ...base, pageSize: 49 }).success).toBe(
      false,
    );
    expect(courseCatalogSectionSchema.safeParse({ ...base, pageSize: 6 }).success).toBe(
      true,
    );
    expect(courseCatalogSectionSchema.safeParse({ ...base, pageSize: 48 }).success).toBe(
      true,
    );
  });

  it('is accepted as a section instance type', () => {
    const result = sectionInstanceSchema.safeParse({
      id: 'sec-catalog',
      type: 'courseCatalog',
      enabled: true,
      visibility: { desktop: true, tablet: true, mobile: true },
      config: base,
    });
    expect(result.success).toBe(true);
  });
});

describe('featuredCoursesSectionSchema', () => {
  const base = {
    title: 'Courses',
    mode: 'latest',
    layout: 'grid',
    count: 3,
    showPrice: true,
    showInstructor: true,
  };

  it('rejects an invalid `mode` enum value', () => {
    const result = featuredCoursesSectionSchema.safeParse({ ...base, mode: 'random' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid `layout` enum value', () => {
    const result = featuredCoursesSectionSchema.safeParse({ ...base, layout: 'list' });
    expect(result.success).toBe(false);
  });

  it('rejects `count` below the minimum', () => {
    const result = featuredCoursesSectionSchema.safeParse({ ...base, count: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects `count` above MAX_SECTION_ITEMS', () => {
    const result = featuredCoursesSectionSchema.safeParse({ ...base, count: 13 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean `showPrice`', () => {
    const result = featuredCoursesSectionSchema.safeParse({ ...base, showPrice: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid `courseIds` array in `selected` mode', () => {
    const result = featuredCoursesSectionSchema.safeParse({
      ...base,
      mode: 'selected',
      courseIds: ['course-1', 'course-2'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a `courseIds` array with a non-string item', () => {
    const result = featuredCoursesSectionSchema.safeParse({
      ...base,
      mode: 'selected',
      courseIds: [123],
    });
    expect(result.success).toBe(false);
  });
});

describe('statisticsSectionSchema', () => {
  it('rejects an item missing a required field', () => {
    const result = statisticsSectionSchema.safeParse({
      items: [{ id: '1', value: '99%' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than MAX_SECTION_ITEMS items', () => {
    const items = Array.from({ length: 13 }, (_, i) => ({
      id: `${i}`,
      value: '1',
      label: 'x',
    }));
    expect(statisticsSectionSchema.safeParse({ items }).success).toBe(false);
  });

  it('accepts exactly MAX_SECTION_ITEMS items', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`,
      value: '1',
      label: 'x',
    }));
    expect(statisticsSectionSchema.safeParse({ items }).success).toBe(true);
  });
});

describe('featuresSectionSchema', () => {
  it('rejects an `icon` outside the bounded FEATURE_ICON_OPTIONS set', () => {
    const result = featuresSectionSchema.safeParse({
      items: [{ id: '1', title: 'Fast', description: 'x', icon: 'RandomIconName' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a real registered icon name', () => {
    const result = featuresSectionSchema.safeParse({
      items: [{ id: '1', title: 'Fast', description: 'x', icon: 'GraduationCap' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('testimonialsSectionSchema', () => {
  it('rejects an item missing the required `authorName`', () => {
    const result = testimonialsSectionSchema.safeParse({
      items: [{ id: '1', quote: 'Great course' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional `libraryEntryIds` reference list (structural only — resolved in a later phase)', () => {
    const result = testimonialsSectionSchema.safeParse({
      items: [],
      libraryEntryIds: ['entry-1'],
    });
    expect(result.success).toBe(true);
  });
});

describe('gallerySectionSchema', () => {
  it('rejects an image item missing the required `image` field', () => {
    const result = gallerySectionSchema.safeParse({ images: [{ id: '1' }] });
    expect(result.success).toBe(false);
  });
});

describe('contactSectionSchema', () => {
  it('rejects an invalid email format', () => {
    const result = contactSectionSchema.safeParse({
      email: 'not-an-email',
      showForm: true,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty-string email (treated as unset)', () => {
    const result = contactSectionSchema.safeParse({ email: '', showForm: true });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required `showForm`', () => {
    expect(contactSectionSchema.safeParse({}).success).toBe(false);
  });
});

describe('content limits — violation payload', () => {
  function violationsOf(sections: unknown): unknown {
    try {
      parseOrThrow(sectionInstanceArraySchema, sections);
    } catch (error) {
      return (error as BadRequestException).getResponse();
    }
    throw new Error('expected a validation failure');
  }

  it('names the section index, the field and the language of every over-limit value', () => {
    const steps = {
      id: 'section-2',
      type: 'steps',
      enabled: true,
      visibility,
      config: {
        items: [
          { id: 'i1', title: { en: 'Step', ar: 'ع'.repeat(MAX_STEP_TITLE_LENGTH + 1) } },
        ],
      },
    };
    const response = violationsOf([
      heroInstance({
        config: {
          title: { en: 'x'.repeat(MAX_HERO_TITLE_LENGTH + 1), ar: '' },
          cta: { label: { en: 'Go', ar: 'ع'.repeat(MAX_CTA_LABEL_LENGTH + 1) } },
        },
      }),
      steps,
    ]);

    expect(response).toEqual({
      messageKey: 'errors.validation.failed',
      violations: [
        { field: '0.config.title.en', messageKey: 'validation:maxLength' },
        { field: '0.config.cta.label.ar', messageKey: 'validation:maxLength' },
        { field: '1.config.items.0.title.ar', messageKey: 'validation:maxLength' },
      ],
    });
  });

  it('accepts every capped field at exactly its limit', () => {
    const at = (n: number) => ({ en: 'a'.repeat(n), ar: 'ع'.repeat(n) });
    expect(
      heroSectionSchema.safeParse({
        eyebrow: at(MAX_HERO_EYEBROW_LENGTH),
        title: at(MAX_HERO_TITLE_LENGTH),
        highlight: at(MAX_HERO_TITLE_LENGTH),
        subtitle: at(MAX_HERO_SUBTITLE_LENGTH),
        description: at(MAX_HERO_DESCRIPTION_LENGTH),
        cta: { label: at(MAX_CTA_LABEL_LENGTH) },
      }).success,
    ).toBe(true);
    expect(
      stepsSectionSchema.safeParse({
        title: at(MAX_STEPS_TITLE_LENGTH),
        description: at(MAX_STEPS_DESCRIPTION_LENGTH),
        image: 'theme-asset:atelier/home-method',
        imageAlt: at(MAX_SHORT_TEXT),
        items: [
          {
            id: 'i1',
            title: at(MAX_STEP_TITLE_LENGTH),
            description: at(MAX_STEP_DESCRIPTION_LENGTH),
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      statisticsSectionSchema.safeParse({
        title: at(MAX_STATISTICS_TITLE_LENGTH),
        items: [{ id: 's1', value: at(5), label: at(MAX_STATISTIC_LABEL_LENGTH) }],
      }).success,
    ).toBe(true);
  });

  it('counts Arabic diacritics as characters, exactly like `string.length`', () => {
    const vowelled = 'عَ'.repeat(MAX_HERO_TITLE_LENGTH / 2);
    expect(vowelled.length).toBe(MAX_HERO_TITLE_LENGTH);
    expect(
      heroSectionSchema.safeParse({ title: { en: 'x', ar: vowelled } }).success,
    ).toBe(true);
    expect(
      heroSectionSchema.safeParse({ title: { en: 'x', ar: `${vowelled}ـ` } }).success,
    ).toBe(false);
  });
});

describe('custom section (CMS phase 3c) on a page', () => {
  const lt = (en: string) => ({ en, ar: '' });

  it('accepts every element kind and keeps each field, storing a pasted YouTube link as its id', () => {
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 'custom-1',
        type: 'custom',
        enabled: true,
        visibility,
        design: { reverseOnMobile: true },
        config: {
          title: lt('Why families choose us'),
          layout: 'two',
          ratio: 'wideNarrow',
          verticalAlign: 'center',
          columns: [
            {
              id: 'c1',
              elements: [
                { id: 'e1', kind: 'heading', level: 'h3', text: lt('Small groups') },
                { id: 'e2', kind: 'text', text: lt('Line one\n\nLine two') },
                { id: 'e3', kind: 'button', cta: { label: lt('Book'), pageId: 'p' } },
                {
                  id: 'e4',
                  kind: 'checklist',
                  items: [{ id: 'i', text: lt('Weekly tests') }],
                },
                { id: 'e5', kind: 'spacer', size: 'large' },
                { id: 'e6', kind: 'divider' },
                { id: 'e7', kind: 'iconText', icon: 'Award', title: lt('Certified') },
              ],
            },
            {
              id: 'c2',
              elements: [
                {
                  id: 'e8',
                  kind: 'image',
                  image: '/api/v1/public/media/academies/a/b.png',
                  imageAlt: lt('A class'),
                  ratio: 'portrait',
                },
                { id: 'e9', kind: 'video', videoId: 'https://youtu.be/dQw4w9WgXcQ' },
              ],
            },
          ],
        },
      },
    ]);
    expect(result.success).toBe(true);
    const config = (result.data as { config: Record<string, unknown> }[])[0].config as {
      columns: { elements: Record<string, unknown>[] }[];
    };
    expect(config.columns[0].elements).toHaveLength(7);
    expect(config.columns[1].elements[1].videoId).toBe('dQw4w9WgXcQ');
    expect(config.columns[1].elements[0].ratio).toBe('portrait');
  });

  it('names a layout whose columns do not match, and an unsafe button address inside a column', () => {
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 'custom-1',
        type: 'custom',
        enabled: true,
        visibility,
        config: {
          layout: 'three',
          columns: [
            {
              id: 'c1',
              elements: [
                {
                  id: 'b',
                  kind: 'button',
                  cta: { label: lt('Go'), url: 'javascript:alert(1)' },
                },
              ],
            },
          ],
        },
      },
    ]);
    expect(result.success).toBe(false);
    const issues = result.error?.issues.map((issue) => [
      issue.path.join('.'),
      issue.message,
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ['0.config.columns.0.elements.0.cta.url', 'validation:invalidUrl'],
        ['0.config.columns', 'validation:customColumnCount'],
      ]),
    );
  });

  it('refuses an element kind it does not know', () => {
    const result = sectionInstanceArraySchema.safeParse([
      {
        id: 'custom-1',
        type: 'custom',
        enabled: true,
        visibility,
        config: {
          layout: 'one',
          columns: [
            { id: 'c1', elements: [{ id: 'x', kind: 'html', html: '<b>hi</b>' }] },
          ],
        },
      },
    ]);
    expect(result.success).toBe(false);
  });
});
