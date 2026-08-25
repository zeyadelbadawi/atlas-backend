import {
  aboutSectionSchema,
  contactSectionSchema,
  featuredCoursesSectionSchema,
  featuresSectionSchema,
  gallerySectionSchema,
  heroSectionSchema,
  sectionInstanceArraySchema,
  sectionInstanceSchema,
  statisticsSectionSchema,
  testimonialsSectionSchema,
} from './section-config.schemas';

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
