/**
 * Manara (Theme 3) starter content — template v1 (frontend repo,
 * Reports/THEME_3_MANARA_PLAN.md §3.10, §3.11, §3.13, §3.14).
 *
 * The template data itself (composition, sample and live-data rules, asset
 * references with alt text, bilingual copy, content limits), then both
 * generation modes through the real `WebsiteGenerationService` with
 * in-memory repositories: every generated page validates, nothing authored
 * is stripped by the section schemas, CTA intents resolve, and the rules
 * hold after generation. The safety rules are Theme 1's
 * (`modern-education.template.spec.ts`), applied unchanged.
 */
import type { Prisma } from '@prisma/client';
import {
  FEATURE_ICON_OPTIONS,
  SELECTABLE_WEBSITE_THEME_KEYS,
  THEME_ASSET_REFERENCE_PATTERN,
} from '../constants/website.constants';
import { WebsiteBootstrapService } from '../services/website-bootstrap.service';
import { WebsiteGenerationService } from '../services/website-generation.service';
import {
  getSectionConfigSchema,
  sectionInstanceArraySchema,
} from '../validation/section-config.schemas';
import { getWebsiteTemplate } from './website-template.registry';
import { manaraTemplate } from './manara.template';
import { atelierTemplate } from './atelier.template';
import { modernEducationTemplate } from './modern-education.template';
import type { SectionType, WebsiteTemplateDefinition } from './website-template.types';

type Row = Record<string, unknown>;
type Section = { type: string; config: Record<string, unknown> };
const tx = {} as Prisma.TransactionClient;
const ACADEMY = { id: 'a1', name: 'Cedar Academy', description: null };

/** Plan §3.10: proof-first — stage, scoreboard, tracks, courses, then the method and the close. */
const HOME_ORDER = [
  'hero',
  'statistics',
  'courseCategories',
  'featuredCourses',
  'featureSplit',
  'steps',
  'features',
  'testimonials',
  'instructors',
  'faq',
  'cta',
];

/** Plan §3.11 — every inner page's order. */
const PAGE_ORDERS: Record<string, string[]> = {
  about: [
    'pageHeader',
    'featureSplit',
    'features',
    'statistics',
    'instructors',
    'gallery',
    'cta',
  ],
  courses: ['pageHeader', 'courseCatalog', 'cta'],
  faqs: ['pageHeader', 'faq', 'cta'],
  contact: ['pageHeader', 'contact', 'faq'],
};

/** Plan §3.13 — the Manara asset keys. */
const ASSET_KEYS = new Set([
  'home-hero',
  'home-benefit',
  'home-cta',
  'courses-launching',
  'about-header',
  'about-story',
  'gallery-1',
  'gallery-2',
  'gallery-3',
  'gallery-4',
  'gallery-5',
  'auth-side',
  'course-fallback',
  'theme-card',
]);

function collect(
  value: unknown,
  match: (key: string, value: unknown) => boolean,
): unknown[] {
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, entry] of Object.entries(node)) {
      if (match(key, entry)) found.push(entry);
      walk(entry);
    }
  };
  walk(value);
  return found;
}

/** Every `{ en, ar }` pair in `value`. */
function localizedLeaves(value: unknown): Array<{ en: string; ar: string }> {
  return collect(
    value,
    (_key, entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Row).en === 'string' &&
      typeof (entry as Row).ar === 'string',
  ) as Array<{ en: string; ar: string }>;
}

/** Every leaf path (`a.b[0].c`) in `value`. */
function leafPaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leafPaths(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) =>
      leafPaths(entry, path ? `${path}.${key}` : key),
    );
  }
  return [path];
}

function hasPath(value: unknown, path: string): boolean {
  let node: unknown = value;
  for (const part of path.split(/\.|\[(\d+)\]/).filter(Boolean)) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Row)[part];
  }
  return true;
}

/** Authored starter copy, sample testimonials excluded (preview-only, never served). */
function starterStrings(template: WebsiteTemplateDefinition): string[] {
  return localizedLeaves(
    template.pages.map((page) =>
      page.sections.map((section) => ({
        ...section.starterContent,
        items: Array.isArray(section.starterContent?.items)
          ? (section.starterContent.items as Row[]).filter((item) => !item.sample)
          : section.starterContent?.items,
      })),
    ),
  ).flatMap((leaf) => [leaf.en, leaf.ar]);
}

const allSections = () => manaraTemplate.pages.flatMap((page) => page.sections);

function setup() {
  let configuration: Row | null = null;
  const pages: Row[] = [];
  const configurationRepository = {
    findByAcademyId: async () => configuration,
    create: async (_tx: unknown, data: Row) => {
      const rest = { ...data };
      delete rest.academy;
      configuration = { ...rest, academyId: ACADEMY.id, templateKey: null };
      return configuration;
    },
    update: async (_tx: unknown, _id: string, data: Row) => {
      configuration = { ...configuration!, ...data };
      return configuration;
    },
  };
  const pagesRepository = {
    findCoreByType: async (_tx: unknown, _a: string, coreType: string) =>
      pages.find((page) => page.coreType === coreType) ?? null,
    findById: async (_tx: unknown, _a: string, id: string) =>
      pages.find((page) => page.id === id) ?? null,
    create: async (_tx: unknown, data: Row) => {
      const page = { ...data, id: `page-${String(data.coreType)}` };
      pages.push(page);
      return page;
    },
    update: async (_tx: unknown, id: string, data: Row) => {
      Object.assign(
        pages.find((page) => page.id === id)!,
        data,
      );
    },
  };
  const service = new WebsiteGenerationService(
    { findById: async () => ACADEMY } as never,
    configurationRepository as never,
    pagesRepository as never,
    new WebsiteBootstrapService(
      configurationRepository as never,
      pagesRepository as never,
    ),
  );
  const page = (coreType: string) =>
    pages.find((candidate) => candidate.coreType === coreType)!.sections as Section[];
  return { service, pages, page, configuration: () => configuration };
}

describe('Manara template v1 — the template', () => {
  it('is selectable (appended, the default unchanged), version 1, and the registry serves it for manara', () => {
    expect(SELECTABLE_WEBSITE_THEME_KEYS).toContain('manara');
    expect(SELECTABLE_WEBSITE_THEME_KEYS[0]).toBe('modern-education');
    expect(SELECTABLE_WEBSITE_THEME_KEYS.indexOf('manara')).toBeGreaterThan(
      SELECTABLE_WEBSITE_THEME_KEYS.indexOf('atelier'),
    );
    expect(manaraTemplate.themeKey).toBe('manara');
    expect(manaraTemplate.version).toBe(1);
    expect(getWebsiteTemplate('manara')).toBe(manaraTemplate);
  });

  it('composes every page exactly per plan §3.10–§3.11', () => {
    const byType = Object.fromEntries(
      manaraTemplate.pages.map((page) => [page.coreType, page.sections]),
    );
    expect(Object.keys(byType)).toEqual(['home', 'about', 'courses', 'faqs', 'contact']);
    expect(byType.home.map((section) => section.type)).toEqual(HOME_ORDER);
    for (const [coreType, order] of Object.entries(PAGE_ORDERS)) {
      expect({
        coreType,
        order: byType[coreType].map((section) => section.type),
      }).toEqual({ coreType, order });
    }
  });

  it('the stage: Join → Sign Up, Browse → Courses, three proof pills, the search, the poster', () => {
    const hero = manaraTemplate.pages[0].sections[0];
    expect(hero.type).toBe('hero');
    expect(hero.ctaTargets).toEqual({ cta: 'signUp', secondaryCta: 'courses' });
    expect(hero.dynamicDefaults).toEqual({ showSearch: true });
    expect(hero.assets).toMatchObject({ image: 'theme-asset:manara/home-hero' });
    expect(hero.starterContent?.highlights).toHaveLength(3);
    const title = hero.starterContent?.title as { en: string; ar: string };
    const highlight = hero.starterContent?.highlight as { en: string; ar: string };
    expect(title.en).toContain(highlight.en);
    expect(title.ar).toContain(highlight.ar);
  });

  it('the banners: every inner page opens with a pageHeader; the About banner carries its image; search where the page has one', () => {
    const byType = Object.fromEntries(
      manaraTemplate.pages.map((page) => [page.coreType, page.sections]),
    );
    for (const coreType of ['about', 'courses', 'faqs', 'contact']) {
      expect(byType[coreType][0].type).toBe('pageHeader');
    }
    expect(byType.about[0].assets).toMatchObject({
      image: 'theme-asset:manara/about-header',
    });
    expect(byType.courses[0].dynamicDefaults).toEqual({ search: 'courses' });
    expect(byType.faqs[0].dynamicDefaults).toEqual({ search: 'faq' });
    expect(byType.about[0].dynamicDefaults).toEqual({ search: 'none' });
    expect(byType.contact[0].dynamicDefaults).toEqual({ search: 'none' });
  });

  it('How we teach carries the home-benefit plate, honours imagePosition, and has three numbered points', () => {
    const split = manaraTemplate.pages[0].sections.find(
      (section) => section.type === 'featureSplit',
    )!;
    expect(split.assets).toMatchObject({ image: 'theme-asset:manara/home-benefit' });
    expect(split.dynamicDefaults).toEqual({ imagePosition: 'start' });
    expect(split.starterContent?.items).toHaveLength(3);
    const story = manaraTemplate.pages[1].sections.find(
      (section) => section.type === 'featureSplit',
    )!;
    expect(story.assets).toMatchObject({ image: 'theme-asset:manara/about-story' });
    expect(story.dynamicDefaults).toEqual({ imagePosition: 'end' });
  });

  it('three steps, four included features with allowed icons, and the FAQ teasers', () => {
    const home = manaraTemplate.pages[0].sections;
    const steps = home.find((section) => section.type === 'steps')!;
    expect(steps.starterContent?.items).toHaveLength(3);
    const features = home.find((section) => section.type === 'features')!;
    const items = features.starterContent?.items as Row[];
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(FEATURE_ICON_OPTIONS).toContain(item.icon);
    }
    const homeFaq = home.find((section) => section.type === 'faq')!;
    expect(homeFaq.dynamicDefaults).toEqual({ maxItems: 4 });
    expect(homeFaq.ctaTargets).toEqual({ cta: 'contact' });
    const contactFaq = manaraTemplate.pages
      .find((page) => page.coreType === 'contact')!
      .sections.find((section) => section.type === 'faq')!;
    expect(contactFaq.dynamicDefaults).toEqual({ maxItems: 3 });
    const faqsPage = manaraTemplate.pages
      .find((page) => page.coreType === 'faqs')!
      .sections.find((section) => section.type === 'faq')!;
    expect(faqsPage.starterContent?.items).toHaveLength(8);
  });

  it('the closing block: Join → Sign Up, Contact, the home-cta image', () => {
    const cta = manaraTemplate.pages[0].sections.at(-1)!;
    expect(cta.type).toBe('cta');
    expect(cta.ctaTargets).toEqual({ cta: 'signUp', secondaryCta: 'contact' });
    expect(cta.assets).toMatchObject({ image: 'theme-asset:manara/home-cta' });
  });

  it('every CTA intent names a core page or an auth surface, only on sections with that CTA field', () => {
    const targets = new Set([
      'home',
      'about',
      'courses',
      'faqs',
      'contact',
      'signIn',
      'signUp',
    ]);
    const withCta: SectionType[] = ['hero', 'faq', 'cta', 'featureSplit'];
    for (const section of allSections()) {
      if (!section.ctaTargets) continue;
      expect(withCta).toContain(section.type);
      for (const [key, target] of Object.entries(section.ctaTargets)) {
        expect(['cta', 'secondaryCta']).toContain(key);
        expect(targets.has(target)).toBe(true);
        // A resolved intent needs an authored label to attach to.
        expect(section.starterContent?.[key]).toMatchObject({ label: expect.anything() });
      }
    }
  });

  it('statistics are metric-only: no authored number anywhere in the template', () => {
    const items = manaraTemplate.pages.flatMap((page) =>
      page.sections
        .filter((section) => section.type === 'statistics')
        .flatMap((section) => [
          ...((section.dynamicDefaults?.items as Row[]) ?? []),
          ...((section.starterContent?.items as Row[]) ?? []),
        ]),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.metric).toMatch(/^(courses|students|instructors)$/);
      expect(item.value).toEqual({ en: '', ar: '' });
    }
  });

  it('testimonials are samples with no photos of people, in a student register', () => {
    const items = allSections()
      .filter((section) => section.type === 'testimonials')
      .flatMap((section) => (section.starterContent?.items as Row[]) ?? []);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sample).toBe(true);
      expect(item.avatar).toBeUndefined();
      expect(item.rating).toBeUndefined();
    }
    expect(items.map((item) => (item.authorRole as Row).en)).toEqual([
      'Secondary-school student',
      'Parent',
      'University applicant',
    ]);
  });

  it('every image is a valid Manara asset reference from plan §3.13, lives in `assets`, and carries alt text', () => {
    const images = collect(manaraTemplate, (key) => key === 'image') as string[];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(THEME_ASSET_REFERENCE_PATTERN);
      expect(image).toMatch(/^theme-asset:manara\//);
      expect(ASSET_KEYS.has(image.slice('theme-asset:manara/'.length))).toBe(true);
    }
    for (const section of allSections()) {
      expect(collect(section.starterContent ?? {}, (key) => key === 'image')).toEqual([]);
      // Alt text travels with the image: wherever `image` is, `imageAlt` is beside it.
      const holders = collect(
        section.assets ?? {},
        (_key, entry) =>
          typeof entry === 'object' && entry !== null && 'image' in (entry as Row),
      ) as Row[];
      const roots = section.assets && 'image' in section.assets ? [section.assets] : [];
      for (const holder of [...roots, ...holders]) {
        const alt = holder.imageAlt as { en: string; ar: string };
        expect(alt.en.trim()).not.toBe('');
        expect(alt.ar).toMatch(/[؀-ۿ]/);
        expect(alt.en).not.toContain('{{');
        expect(alt.ar).not.toContain('{{');
      }
    }
    expect(
      new Set(images.map((image) => image.slice('theme-asset:manara/'.length))),
    ).toEqual(
      new Set([
        'home-hero',
        'home-benefit',
        'home-cta',
        'about-header',
        'about-story',
        'gallery-1',
        'gallery-2',
        'gallery-3',
        'gallery-4',
        'gallery-5',
      ]),
    );
  });

  it('never shares a photograph with Theme 1 or Atelier (the reference namespaces differ)', () => {
    for (const other of [modernEducationTemplate, atelierTemplate]) {
      const images = collect(other, (key) => key === 'image') as string[];
      for (const image of images) expect(image).not.toMatch(/^theme-asset:manara\//);
    }
  });

  it('every authored string is inside its section schema limit, counting Arabic too', () => {
    for (const page of manaraTemplate.pages) {
      page.sections.forEach((section, index) => {
        const config = {
          ...(section.type === 'features' ||
          section.type === 'testimonials' ||
          section.type === 'faq' ||
          section.type === 'steps' ||
          section.type === 'featureSplit'
            ? { items: [] }
            : {}),
          ...(section.type === 'gallery' ? { images: [] } : {}),
          ...section.dynamicDefaults,
          ...section.assets,
          ...section.starterContent,
          ...(section.type === 'cta' && !section.starterContent?.cta
            ? { cta: { label: { en: 'x', ar: '' } } }
            : {}),
        };
        const result = getSectionConfigSchema(section.type).safeParse(config);
        expect({
          page: page.coreType,
          index,
          type: section.type,
          issues: result.success ? [] : result.error.issues,
        }).toEqual({ page: page.coreType, index, type: section.type, issues: [] });
      });
    }
  });

  it('is genuinely bilingual: every authored pair has English and Arabic, and the Arabic is Arabic', () => {
    const leaves = localizedLeaves(
      manaraTemplate.pages.flatMap((page) =>
        page.sections.map((section) => section.starterContent ?? {}),
      ),
    );
    expect(leaves.length).toBeGreaterThan(50);
    for (const leaf of leaves) {
      expect(leaf.en.trim()).not.toBe('');
      expect(leaf.ar.trim()).not.toBe('');
      expect(leaf.ar).toMatch(/[؀-ۿ]/);
    }
  });

  it('speaks in its own voice: no starter copy borrowed from Theme 1 or Atelier beyond plain labels', () => {
    const borrowed = new Set([
      ...starterStrings(modernEducationTemplate),
      ...starterStrings(atelierTemplate),
    ]);
    const shared = new Set(
      starterStrings(manaraTemplate).filter((text) => borrowed.has(text)),
    );
    expect(shared).toEqual(
      new Set([
        'About {{academyName}}',
        'عن {{academyName}}',
        'Our story',
        'قصّتنا',
        'Courses',
        'الدورات',
        'All courses',
        'كل الدورات',
        'Browse courses',
        'تصفّح الدورات',
        'Contact',
        'Contact us',
        'تواصل معنا',
        'الأسئلة الشائعة',
        'All questions',
        'كل الأسئلة',
        // The scoreboard's title is the plan's own (§3.10 #2).
        '{{academyName}} in numbers',
        '{{academyName}} بالأرقام',
      ]),
    );
  });

  it('starter copy makes no claim an Academy may not be able to keep (EN and AR)', () => {
    const strings = starterStrings(manaraTemplate);
    expect(strings.length).toBeGreaterThan(50);
    // Atelier's list, minus the plan's own closing block ("Enrolment is
    // open", §3.10 #11), plus the exam-season promises a teacher-led
    // template is tempted by: scores, results, grades, guarantees, speed.
    const banned = [
      /\bfree\b/i,
      /pay securely/i,
      /مجاني/,
      /بأمان عبر الإنترنت/,
      /get back to you/i,
      /we will reply/i,
      /we will point you/i,
      /answered by the instructor/i,
      /سيعود إليك|سنعود إليك|وسنردّ عليك|وسنرشدك/,
      /يجيب المدرّب|يجيب المعلّم/,
      /start any time/i,
      /whenever you need them/i,
      /ابدأ في أي وقت/,
      /real instructors/i,
      /expert(-led)?\b/i,
      /experienced/i,
      /best teacher/i,
      /real support/i,
      /practitioners/i,
      /mentor/i,
      /مدرّبين حقيقيين|مدرّبون خبراء|يقدّمها خبراء|يقوده خبراء|ذوو خبرة|أفضل معلّم/,
      /دعم حقيقي/,
      /every course ends with/i,
      /career/i,
      /مسيرتك المهنية/,
      /learners recommend/i,
      /learners choose us/i,
      /students choose us/i,
      /ask us most/i,
      /يوصي بها|يختارنا/,
      /certificat/i,
      /refund/i,
      /guarantee/i,
      /شهاد/,
      /استرداد/,
      /ضمان|نضمن/,
      /full marks/i,
      /top (marks|grades|scores)/i,
      /higher (marks|grades|scores)/i,
      /raise your (grade|score)/i,
      /pass the exam/i,
      /\bA\+/,
      /الدرجات النهائية|درجات أعلى|أعلى الدرجات|ترفع درجتك|تنجح في الامتحان|النجاح مضمون/,
      /in minutes/i,
      /within (an hour|24 hours|a day)/i,
      /خلال دقائق|خلال ساعة|خلال 24 ساعة/,
      /24\/7/,
      /على مدار الساعة/,
      /thousands of students/i,
      /آلاف الطلاب/,
    ];
    for (const text of strings) {
      for (const pattern of banned) {
        expect({ text, matches: pattern.test(text) }).toEqual({ text, matches: false });
      }
    }
  });

  it('hardcodes no grade year, subject or exam name — exam season is register, not a claim', () => {
    const strings = [
      ...starterStrings(manaraTemplate),
      ...localizedLeaves(allSections().map((section) => section.assets ?? {})).flatMap(
        (leaf) => [leaf.en, leaf.ar],
      ),
    ];
    const specific = [
      /thanaw(e|i)ya/i,
      /الثانوية العامة/,
      /grade (1[0-2]|[1-9])\b/i,
      /الصفّ? (الأول|الثاني|الثالث)/,
      /\b(math|maths|physics|chemistry|biology|arabic|english|french|history|geography)\b/i,
      /الرياضيات|الفيزياء|الكيمياء|الأحياء|اللغة العربية|اللغة الإنجليزية|الفرنسية|التاريخ|الجغرافيا/,
      /\b(IELTS|TOEFL|SAT|IGCSE|GCSE)\b/,
      /آيلتس|توفل/,
    ];
    for (const text of strings) {
      for (const pattern of specific) {
        expect({ text, matches: pattern.test(text) }).toEqual({ text, matches: false });
      }
    }
  });

  it('copy interpolates only {{academyName}}, and never inside alt text', () => {
    const tokens = JSON.stringify(manaraTemplate).match(/\{\{\w+\}\}/g) ?? [];
    expect(new Set(tokens)).toEqual(new Set(['{{academyName}}']));
    expect(
      JSON.stringify(allSections().map((section) => section.assets ?? {})),
    ).not.toContain('{{');
  });
});

describe('Manara template v1 — generation', () => {
  it.each(['complete', 'empty'] as const)(
    '%s mode: every page validates, CTA intents resolve, rules hold',
    async (mode) => {
      const { service, pages, page } = setup();
      const result = await service.generate(tx, ACADEMY.id, 'manara', mode);
      expect(result).toEqual({ pagesCreated: 5, pagesSkipped: 0 });

      for (const generated of pages) {
        expect(sectionInstanceArraySchema.safeParse(generated.sections).success).toBe(
          true,
        );
      }
      expect(page('home').map((section) => section.type)).toEqual(HOME_ORDER);
      for (const [coreType, order] of Object.entries(PAGE_ORDERS)) {
        expect(page(coreType).map((section) => section.type)).toEqual(order);
      }

      // Theme images, with alt text, and structure in both modes.
      const hero = page('home')[0].config;
      expect(hero.image).toBe('theme-asset:manara/home-hero');
      expect(hero.imageAlt).toMatchObject({ en: expect.stringMatching(/\S/) });
      expect(hero.showSearch).toBe(true);
      expect(page('home')[4].config.image).toBe('theme-asset:manara/home-benefit');
      expect(page('home')[4].config.imagePosition).toBe('start');
      expect(page('home').at(-1)!.config.image).toBe('theme-asset:manara/home-cta');
      const gallery = page('about').find((section) => section.type === 'gallery')!.config;
      expect((gallery.images as Row[]).map((image) => image.image)).toEqual(
        [1, 2, 3, 4, 5].map((n) => `theme-asset:manara/gallery-${n}`),
      );
      for (const image of gallery.images as Row[]) {
        expect(image.imageAlt).toMatchObject({ en: expect.stringMatching(/\S/) });
      }

      // No hand-typed statistics in either mode.
      for (const coreType of ['home', 'about']) {
        const stats = page(coreType).find((section) => section.type === 'statistics')!;
        expect((stats.config.items as Row[]).length).toBe(3);
        for (const item of stats.config.items as Row[]) {
          expect(item.metric).toBeDefined();
          expect(item.value).toEqual({ en: '', ar: '' });
        }
      }

      // CTA intents resolve to Sign Up and to the pages just created.
      const cta = page('home').at(-1)!.config;
      expect(cta.cta).toMatchObject({ authAction: 'signUp' });
      if (mode === 'complete') {
        expect(hero.cta).toMatchObject({ authAction: 'signUp' });
        expect(hero.secondaryCta).toMatchObject({ pageId: 'page-courses' });
        expect(cta.secondaryCta).toMatchObject({ pageId: 'page-contact' });
        expect(
          page('home').find((section) => section.type === 'faq')!.config.cta,
        ).toMatchObject({ pageId: 'page-contact' });
        expect(
          page('contact').find((section) => section.type === 'faq')!.config.cta,
        ).toMatchObject({ pageId: 'page-faqs' });
        expect(page('about').at(-1)!.config.cta).toMatchObject({
          pageId: 'page-courses',
        });
        expect(page('courses').at(-1)!.config.cta).toMatchObject({
          pageId: 'page-contact',
        });
        expect(page('faqs').at(-1)!.config.cta).toMatchObject({ pageId: 'page-contact' });
      }

      // Banners: authored in complete mode; the page's own title in empty mode.
      const aboutHeader = page('about')[0].config;
      expect(aboutHeader.image).toBe('theme-asset:manara/about-header');
      if (mode === 'complete') {
        expect(aboutHeader.eyebrow).toEqual({
          en: 'About Cedar Academy',
          ar: 'عن Cedar Academy',
        });
        expect(hero.eyebrow).toEqual({
          en: 'Cedar Academy — learn with your teacher',
          ar: 'Cedar Academy — تعلّم مع معلّمك',
        });
      } else {
        expect(aboutHeader.title).toEqual({ en: 'About', ar: 'من نحن' });
        expect(hero.title).toEqual({ en: 'Cedar Academy', ar: '' });
      }
      expect(JSON.stringify(pages)).not.toContain('{{');
    },
  );

  it('complete mode keeps every authored field — the section schemas strip nothing', async () => {
    const { service, page } = setup();
    await service.generate(tx, ACADEMY.id, 'manara', 'complete');
    for (const templatePage of manaraTemplate.pages) {
      const generated = page(templatePage.coreType);
      templatePage.sections.forEach((section, index) => {
        const authored = {
          ...section.dynamicDefaults,
          ...section.assets,
          ...section.starterContent,
        };
        for (const path of leafPaths(authored)) {
          expect({
            page: templatePage.coreType,
            index,
            path,
            kept: hasPath(generated[index].config, path),
          }).toEqual({
            page: templatePage.coreType,
            index,
            path,
            kept: true,
          });
        }
      });
    }
  });

  it('complete mode seeds exactly three sample testimonials; empty mode seeds none', async () => {
    const complete = setup();
    await complete.service.generate(tx, ACADEMY.id, 'manara', 'complete');
    const seeded = complete
      .page('home')
      .find((section) => section.type === 'testimonials')!.config.items as Row[];
    expect(seeded.map((item) => item.sample)).toEqual([true, true, true]);

    const empty = setup();
    await empty.service.generate(tx, ACADEMY.id, 'manara', 'empty');
    const none = empty.page('home').find((section) => section.type === 'testimonials')!
      .config.items as Row[];
    expect(none).toEqual([]);
  });

  it('records template v1 provenance', async () => {
    const { service, configuration } = setup();
    await service.generate(tx, ACADEMY.id, 'manara', 'complete');
    expect(configuration()).toMatchObject({ templateKey: 'manara', templateVersion: 1 });
  });
});
