/**
 * Riwaq (Theme 4) starter content — template v1 (frontend repo,
 * Reports/THEME_4_RIWAQ_PLAN.md §4, §6, §7).
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
import { riwaqTemplate } from './riwaq.template';
import { manaraTemplate } from './manara.template';
import { atelierTemplate } from './atelier.template';
import { modernEducationTemplate } from './modern-education.template';
import type { SectionType, WebsiteTemplateDefinition } from './website-template.types';

type Row = Record<string, unknown>;
type Section = { type: string; config: Record<string, unknown> };
const tx = {} as Prisma.TransactionClient;
const ACADEMY = { id: 'a1', name: 'Cedar Academy', description: null };

/** Plan §4: promise → outcomes → choose → inspect → how it works → experience → who teaches → evidence → questions → commit. */
const HOME_ORDER = [
  'hero',
  'features',
  'courseCategories',
  'featuredCourses',
  'courseSpotlight',
  'steps',
  'featureSplit',
  'instructors',
  'statistics',
  'testimonials',
  'faq',
  'cta',
];

/** Plan §4 — every inner page's order. */
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

/** Plan §7 — the Riwaq asset keys. */
const ASSET_KEYS = new Set([
  'home-hero',
  'home-benefit',
  'home-method',
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
  'courses-header',
  'faqs-header',
  'contact-header',
  'coming-soon',
  'not-found',
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

const allSections = () => riwaqTemplate.pages.flatMap((page) => page.sections);

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

describe('Riwaq template v1 — the template', () => {
  it('is selectable (appended after Manara, the default unchanged), version 1, and the registry serves it', () => {
    expect(SELECTABLE_WEBSITE_THEME_KEYS).toContain('riwaq');
    expect(SELECTABLE_WEBSITE_THEME_KEYS[0]).toBe('modern-education');
    expect(SELECTABLE_WEBSITE_THEME_KEYS.indexOf('riwaq')).toBeGreaterThan(
      SELECTABLE_WEBSITE_THEME_KEYS.indexOf('manara'),
    );
    expect(riwaqTemplate.themeKey).toBe('riwaq');
    expect(riwaqTemplate.version).toBe(1);
    expect(getWebsiteTemplate('riwaq')).toBe(riwaqTemplate);
  });

  it('composes every page exactly per plan §4', () => {
    const byType = Object.fromEntries(
      riwaqTemplate.pages.map((page) => [page.coreType, page.sections]),
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

  it('the portico: Programmes → Courses, account → Sign Up, a three-cell spec row, no search, the colonnade', () => {
    const hero = riwaqTemplate.pages[0].sections[0];
    expect(hero.type).toBe('hero');
    expect(hero.ctaTargets).toEqual({ cta: 'courses', secondaryCta: 'signUp' });
    expect(hero.dynamicDefaults).toEqual({ showSearch: false });
    expect(hero.assets).toMatchObject({ image: 'theme-asset:riwaq/home-hero' });
    expect(hero.starterContent?.highlights).toHaveLength(3);
    const title = hero.starterContent?.title as { en: string; ar: string };
    const highlight = hero.starterContent?.highlight as { en: string; ar: string };
    expect(title.en).toContain(highlight.en);
    expect(title.ar).toContain(highlight.ar);
  });

  it('the programme in focus: live switches only — no course, no course copy authored', () => {
    const spotlight = riwaqTemplate.pages[0].sections.find(
      (section) => section.type === 'courseSpotlight',
    )!;
    expect(spotlight.dynamicDefaults).toEqual({
      showOutcomes: true,
      showSyllabus: true,
      maxModules: 6,
    });
    expect(spotlight.starterContent?.courseId).toBeUndefined();
    expect(spotlight.starterContent?.title).toBeUndefined();
    expect(spotlight.ctaTargets).toBeUndefined();
  });

  it('the plates: every inner page opens with a pageHeader carrying its own photograph; search where the page has one', () => {
    const byType = Object.fromEntries(
      riwaqTemplate.pages.map((page) => [page.coreType, page.sections]),
    );
    const plates: Record<string, string> = {
      about: 'about-header',
      courses: 'courses-header',
      faqs: 'faqs-header',
      contact: 'contact-header',
    };
    for (const [coreType, key] of Object.entries(plates)) {
      expect(byType[coreType][0].type).toBe('pageHeader');
      expect(byType[coreType][0].assets).toMatchObject({
        image: `theme-asset:riwaq/${key}`,
      });
    }
    expect(byType.courses[0].dynamicDefaults).toEqual({ search: 'courses' });
    expect(byType.faqs[0].dynamicDefaults).toEqual({ search: 'faq' });
    expect(byType.about[0].dynamicDefaults).toEqual({ search: 'none' });
    expect(byType.contact[0].dynamicDefaults).toEqual({ search: 'none' });
  });

  it('the experience window and the about story honour imagePosition; three points each', () => {
    const split = riwaqTemplate.pages[0].sections.find(
      (section) => section.type === 'featureSplit',
    )!;
    expect(split.assets).toMatchObject({ image: 'theme-asset:riwaq/home-benefit' });
    expect(split.dynamicDefaults).toEqual({ imagePosition: 'start' });
    expect(split.starterContent?.items).toHaveLength(3);
    const story = riwaqTemplate.pages[1].sections.find(
      (section) => section.type === 'featureSplit',
    )!;
    expect(story.assets).toMatchObject({ image: 'theme-asset:riwaq/about-story' });
    expect(story.dynamicDefaults).toEqual({ imagePosition: 'end' });
  });

  it('four study steps with their plate, four outcome cells with allowed icons, and the FAQ teasers', () => {
    const home = riwaqTemplate.pages[0].sections;
    const steps = home.find((section) => section.type === 'steps')!;
    expect(steps.starterContent?.items).toHaveLength(4);
    expect(steps.assets).toMatchObject({ image: 'theme-asset:riwaq/home-method' });
    const features = home.find((section) => section.type === 'features')!;
    const items = features.starterContent?.items as Row[];
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(FEATURE_ICON_OPTIONS).toContain(item.icon);
    }
    const homeFaq = home.find((section) => section.type === 'faq')!;
    expect(homeFaq.dynamicDefaults).toEqual({ maxItems: 4 });
    expect(homeFaq.ctaTargets).toEqual({ cta: 'faqs' });
    const contactFaq = riwaqTemplate.pages
      .find((page) => page.coreType === 'contact')!
      .sections.find((section) => section.type === 'faq')!;
    expect(contactFaq.dynamicDefaults).toEqual({ maxItems: 3 });
    const faqsPage = riwaqTemplate.pages
      .find((page) => page.coreType === 'faqs')!
      .sections.find((section) => section.type === 'faq')!;
    expect(faqsPage.starterContent?.items).toHaveLength(7);
  });

  it('the closing invitation: Programmes → Courses, Contact, the home-cta image', () => {
    const cta = riwaqTemplate.pages[0].sections.at(-1)!;
    expect(cta.type).toBe('cta');
    expect(cta.ctaTargets).toEqual({ cta: 'courses', secondaryCta: 'contact' });
    expect(cta.assets).toMatchObject({ image: 'theme-asset:riwaq/home-cta' });
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
    const withCta: SectionType[] = [
      'hero',
      'faq',
      'cta',
      'featureSplit',
      'courseSpotlight',
    ];
    for (const section of allSections()) {
      if (!section.ctaTargets) continue;
      expect(withCta).toContain(section.type);
      for (const [key, target] of Object.entries(section.ctaTargets)) {
        expect(['cta', 'secondaryCta']).toContain(key);
        expect(targets.has(target)).toBe(true);
        expect(section.starterContent?.[key]).toMatchObject({ label: expect.anything() });
      }
    }
  });

  it('statistics are metric-only: no authored number anywhere in the template', () => {
    const items = riwaqTemplate.pages.flatMap((page) =>
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

  it('testimonials are samples with no photos of people, in a professional register', () => {
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
      'Operations analyst',
      'Changing careers',
      'Team lead',
    ]);
  });

  it('every image is a valid Riwaq asset reference from plan §7, lives in `assets`, and carries alt text', () => {
    const images = collect(riwaqTemplate, (key) => key === 'image') as string[];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(THEME_ASSET_REFERENCE_PATTERN);
      expect(image).toMatch(/^theme-asset:riwaq\//);
      expect(ASSET_KEYS.has(image.slice('theme-asset:riwaq/'.length))).toBe(true);
    }
    for (const section of allSections()) {
      expect(collect(section.starterContent ?? {}, (key) => key === 'image')).toEqual([]);
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
      new Set(images.map((image) => image.slice('theme-asset:riwaq/'.length))),
    ).toEqual(
      new Set([
        'home-hero',
        'home-method',
        'home-benefit',
        'home-cta',
        'about-header',
        'about-story',
        'gallery-1',
        'gallery-2',
        'gallery-3',
        'gallery-4',
        'gallery-5',
        'courses-header',
        'faqs-header',
        'contact-header',
      ]),
    );
  });

  it('never shares a photograph with Themes 1–3 (the reference namespaces differ)', () => {
    for (const other of [modernEducationTemplate, atelierTemplate, manaraTemplate]) {
      const images = collect(other, (key) => key === 'image') as string[];
      for (const image of images) expect(image).not.toMatch(/^theme-asset:riwaq\//);
    }
  });

  it('every authored string is inside its section schema limit, counting Arabic too', () => {
    for (const page of riwaqTemplate.pages) {
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
      riwaqTemplate.pages.flatMap((page) =>
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

  it('speaks in its own voice: no starter copy borrowed from Themes 1–3 beyond plain labels', () => {
    const borrowed = new Set([
      ...starterStrings(modernEducationTemplate),
      ...starterStrings(atelierTemplate),
      ...starterStrings(manaraTemplate),
    ]);
    const shared = new Set(
      starterStrings(riwaqTemplate).filter((text) => borrowed.has(text)),
    );
    expect(shared).toEqual(
      new Set([
        'About {{academyName}}',
        'عن {{academyName}}',
        'Contact',
        'تواصل',
        'All questions',
        'كل الأسئلة',
        'How to reach us',
        'كيف تصل إلينا',
        'Use the details below, or send a message with the form.',
        'استخدم البيانات أدناه، أو أرسل رسالة عبر النموذج.',
        'Answers in brief',
        'إجابات موجزة',
        // Plain labels every theme may share.
        'Create an account',
        'أنشئ حسابًا',
        'How do I pay?',
        'كيف أدفع؟',
        'Questions',
        'Talk to us',
        'تحدّث إلينا',
        'Clarity',
        'الوضوح',
      ]),
    );
  });

  it('starter copy makes no claim an Academy may not be able to keep (EN and AR)', () => {
    const strings = starterStrings(riwaqTemplate);
    expect(strings.length).toBeGreaterThan(50);
    // A professional-institute template is tempted by accreditation, jobs
    // and outcomes it cannot know; none of them appears.
    const banned = [
      /\bfree\b/i,
      /مجاني/,
      /pay securely/i,
      /get back to you/i,
      /we will (reply|point|answer|respond)/i,
      /سيعود إليك|سنعود إليك|وسنردّ عليك|وسنرشدك/,
      /expert(-led)?\b/i,
      /experienced/i,
      /industry[- ]leading/i,
      /world[- ]class/i,
      /خبراء|ذوو خبرة|عالمي المستوى/,
      /accredit/i,
      /recogni[sz]ed/i,
      /معتمد|اعتماد/,
      /\bjobs?\b/i,
      /employ/i,
      /hired/i,
      /salary|promotion/i,
      /وظيفة|توظيف|راتب|ترقية/,
      /guarantee/i,
      /ضمان|نضمن/,
      /refund/i,
      /استرداد/,
      /live sessions?/i,
      /حصص مباشرة|جلسات مباشرة/,
      /24\/7/,
      /على مدار الساعة/,
      /in minutes/i,
      /within (an hour|24 hours|a day)/i,
      /thousands of/i,
      /آلاف/,
    ];
    for (const text of strings) {
      for (const pattern of banned) {
        expect({ text, matches: pattern.test(text) }).toEqual({ text, matches: false });
      }
    }
  });

  it('a certificate is only ever mentioned as conditional on the programme', () => {
    // The question itself ("Do I receive a certificate?") asks; every
    // statement that mentions one says it depends on the programme.
    const mentions = starterStrings(riwaqTemplate).filter(
      (text) => /certificat|شهاد/i.test(text) && !/[?؟]$/.test(text.trim()),
    );
    expect(mentions.length).toBeGreaterThan(0);
    for (const text of mentions) {
      expect({
        text,
        conditional: /some programmes|whether|says|بعض البرامج|ما إذا|توضّح/i.test(text),
      }).toEqual({ text, conditional: true });
    }
  });

  it('copy interpolates only {{academyName}}, and never inside alt text', () => {
    const tokens = JSON.stringify(riwaqTemplate).match(/\{\{\w+\}\}/g) ?? [];
    expect(new Set(tokens)).toEqual(new Set(['{{academyName}}']));
    expect(
      JSON.stringify(allSections().map((section) => section.assets ?? {})),
    ).not.toContain('{{');
  });
});

describe('Riwaq template v1 — generation', () => {
  it.each(['complete', 'empty'] as const)(
    '%s mode: every page validates, CTA intents resolve, rules hold',
    async (mode) => {
      const { service, pages, page } = setup();
      const result = await service.generate(tx, ACADEMY.id, 'riwaq', mode);
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

      const hero = page('home')[0].config;
      expect(hero.image).toBe('theme-asset:riwaq/home-hero');
      expect(hero.imageAlt).toMatchObject({ en: expect.stringMatching(/\S/) });
      expect(hero.showSearch).toBe(false);
      const spotlight = page('home')[4].config;
      expect(spotlight).toMatchObject({
        showOutcomes: true,
        showSyllabus: true,
        maxModules: 6,
      });
      expect(spotlight.courseId).toBeUndefined();
      expect(page('home')[5].config.image).toBe('theme-asset:riwaq/home-method');
      expect(page('home')[6].config.image).toBe('theme-asset:riwaq/home-benefit');
      expect(page('home').at(-1)!.config.image).toBe('theme-asset:riwaq/home-cta');
      const gallery = page('about').find((section) => section.type === 'gallery')!.config;
      expect((gallery.images as Row[]).map((image) => image.image)).toEqual(
        [1, 2, 3, 4, 5].map((n) => `theme-asset:riwaq/gallery-${n}`),
      );

      for (const coreType of ['home', 'about']) {
        const stats = page(coreType).find((section) => section.type === 'statistics')!;
        expect((stats.config.items as Row[]).length).toBe(3);
        for (const item of stats.config.items as Row[]) {
          expect(item.metric).toBeDefined();
          expect(item.value).toEqual({ en: '', ar: '' });
        }
      }

      if (mode === 'complete') {
        const cta = page('home').at(-1)!.config;
        expect(hero.cta).toMatchObject({ pageId: 'page-courses' });
        expect(hero.secondaryCta).toMatchObject({ authAction: 'signUp' });
        expect(cta.cta).toMatchObject({ pageId: 'page-courses' });
        expect(cta.secondaryCta).toMatchObject({ pageId: 'page-contact' });
        expect(
          page('home').find((section) => section.type === 'faq')!.config.cta,
        ).toMatchObject({ pageId: 'page-faqs' });
        expect(hero.eyebrow).toEqual({
          en: 'Cedar Academy — professional programmes',
          ar: 'Cedar Academy — برامج مهنية',
        });
      } else {
        expect(page('about')[0].config.title).toEqual({ en: 'About', ar: 'من نحن' });
        expect(hero.title).toEqual({ en: 'Cedar Academy', ar: '' });
      }
      expect(JSON.stringify(pages)).not.toContain('{{');
    },
  );

  it('complete mode keeps every authored field — the section schemas strip nothing', async () => {
    const { service, page } = setup();
    await service.generate(tx, ACADEMY.id, 'riwaq', 'complete');
    for (const templatePage of riwaqTemplate.pages) {
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
          }).toEqual({ page: templatePage.coreType, index, path, kept: true });
        }
      });
    }
  });

  it('complete mode seeds exactly three sample testimonials; empty mode seeds none', async () => {
    const complete = setup();
    await complete.service.generate(tx, ACADEMY.id, 'riwaq', 'complete');
    const seeded = complete
      .page('home')
      .find((section) => section.type === 'testimonials')!.config.items as Row[];
    expect(seeded.map((item) => item.sample)).toEqual([true, true, true]);
    const empty = setup();
    await empty.service.generate(tx, ACADEMY.id, 'riwaq', 'empty');
    const none = empty.page('home').find((section) => section.type === 'testimonials')!
      .config.items as Row[];
    expect(none).toEqual([]);
  });

  it('records template v1 provenance', async () => {
    const { service, configuration } = setup();
    await service.generate(tx, ACADEMY.id, 'riwaq', 'complete');
    expect(configuration()).toMatchObject({ templateKey: 'riwaq', templateVersion: 1 });
  });
});
