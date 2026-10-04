/**
 * Atelier (Theme 2) starter content — template v1 (frontend repo,
 * Reports/THEME_2_ATELIER_PLAN.md §3, §5).
 *
 * The template data itself (composition, sample and live-data rules, asset
 * references, bilingual copy), then both generation modes through the real
 * `WebsiteGenerationService` with in-memory repositories: every generated
 * page validates, nothing authored is stripped by the section schemas, CTA
 * intents resolve, and the rules hold after generation. The safety rules
 * are Theme 1's (`modern-education.template.spec.ts`), applied unchanged.
 */
import type { Prisma } from '@prisma/client';
import {
  SELECTABLE_WEBSITE_THEME_KEYS,
  THEME_ASSET_REFERENCE_PATTERN,
} from '../constants/website.constants';
import { WebsiteBootstrapService } from '../services/website-bootstrap.service';
import { WebsiteGenerationService } from '../services/website-generation.service';
import { sectionInstanceArraySchema } from '../validation/section-config.schemas';
import { getWebsiteTemplate } from './website-template.registry';
import { atelierTemplate } from './atelier.template';
import { modernEducationTemplate } from './modern-education.template';
import type { WebsiteTemplateDefinition } from './website-template.types';

type Row = Record<string, unknown>;
type Section = { type: string; config: Record<string, unknown> };
const tx = {} as Prisma.TransactionClient;
const ACADEMY = { id: 'a1', name: 'Cedar Academy', description: null };

/** Plan §3: hero, chapters I–V, then the people, the figures and the close. */
const HOME_ORDER = [
  'hero',
  'featureSplit',
  'features',
  'courseCategories',
  'featuredCourses',
  'steps',
  'instructors',
  'statistics',
  'testimonials',
  'faq',
  'cta',
];

/** Plan §5 — the Atelier asset keys. */
const ASSET_KEYS = new Set([
  'home-hero',
  'home-philosophy',
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

describe('Atelier template v1 — the template', () => {
  it('is selectable, version 1, and the registry serves it for atelier', () => {
    expect(SELECTABLE_WEBSITE_THEME_KEYS).toContain('atelier');
    expect(SELECTABLE_WEBSITE_THEME_KEYS[0]).toBe('modern-education');
    expect(atelierTemplate.themeKey).toBe('atelier');
    expect(atelierTemplate.version).toBe(1);
    expect(getWebsiteTemplate('atelier')).toBe(atelierTemplate);
  });

  it('composes Home per plan §3 and opens every inner page with its masthead', () => {
    const byType = Object.fromEntries(
      atelierTemplate.pages.map((page) => [page.coreType, page.sections]),
    );
    expect(Object.keys(byType)).toEqual(['home', 'about', 'courses', 'faqs', 'contact']);
    expect(byType.home.map((section) => section.type)).toEqual(HOME_ORDER);
    for (const coreType of ['about', 'courses', 'faqs', 'contact']) {
      expect(byType[coreType][0].type).toBe('pageHeader');
    }
    expect(byType.about[0].assets).toEqual({ image: 'theme-asset:atelier/about-header' });
    expect(byType.about.map((section) => section.type)).toEqual(
      expect.arrayContaining(['about', 'featureSplit', 'gallery']),
    );
    expect(byType.courses.map((section) => section.type).slice(0, 2)).toEqual([
      'pageHeader',
      'courseCatalog',
    ]);
    expect(byType.faqs.map((section) => section.type).slice(0, 2)).toEqual([
      'pageHeader',
      'faq',
    ]);
    expect(byType.contact.map((section) => section.type).slice(0, 2)).toEqual([
      'pageHeader',
      'contact',
    ]);
    expect(byType.courses[0].dynamicDefaults).toMatchObject({ search: 'courses' });
    expect(byType.faqs[0].dynamicDefaults).toMatchObject({ search: 'faq' });
  });

  it('the Method scene (steps) carries its plate, in both modes', () => {
    const steps = atelierTemplate.pages
      .flatMap((page) => page.sections)
      .filter((section) => section.type === 'steps');
    expect(steps).toHaveLength(1);
    expect(steps[0].assets).toEqual({ image: 'theme-asset:atelier/home-method' });
  });

  it('statistics are metric-only: no authored number anywhere in the template', () => {
    const items = atelierTemplate.pages.flatMap((page) =>
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

  it('testimonials are samples with no photos of people', () => {
    const items = atelierTemplate.pages
      .flatMap((page) => page.sections)
      .filter((section) => section.type === 'testimonials')
      .flatMap((section) => (section.starterContent?.items as Row[]) ?? []);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sample).toBe(true);
      expect(item.avatar).toBeUndefined();
    }
  });

  it('every image is a valid Atelier asset reference from plan §5, and lives in `assets`', () => {
    const images = collect(atelierTemplate, (key) => key === 'image') as string[];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(THEME_ASSET_REFERENCE_PATTERN);
      expect(image).toMatch(/^theme-asset:atelier\//);
      expect(ASSET_KEYS.has(image.slice('theme-asset:atelier/'.length))).toBe(true);
    }
    for (const section of atelierTemplate.pages.flatMap((page) => page.sections)) {
      expect(collect(section.starterContent ?? {}, (key) => key === 'image')).toEqual([]);
    }
  });

  it('is genuinely bilingual: every authored pair has English and Arabic, and the Arabic is Arabic', () => {
    const leaves = localizedLeaves(
      atelierTemplate.pages.flatMap((page) =>
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

  it('speaks in its own voice: no starter copy borrowed from Theme 1 beyond plain labels', () => {
    const theme1 = new Set(starterStrings(modernEducationTemplate));
    const shared = new Set(
      starterStrings(atelierTemplate).filter((text) => theme1.has(text)),
    );
    expect(shared).toEqual(
      new Set(['About {{academyName}}', 'عن {{academyName}}', 'Our story', 'قصّتنا']),
    );
  });

  it('starter copy makes no claim an Academy may not be able to keep (EN and AR)', () => {
    const strings = starterStrings(atelierTemplate);
    expect(strings.length).toBeGreaterThan(50);
    const banned = [
      /some courses are free/i,
      /\bfree\b/i,
      /pay securely/i,
      /بعض الدورات مجانية/,
      /مجاني/,
      /بأمان عبر الإنترنت/,
      /دروس معاينة مجانية/,
      /get back to you/i,
      /we will reply/i,
      /answered by the instructor/i,
      /سيعود إليك|سنعود إليك|وسنردّ عليك|وسنرشدك/,
      /يجيب المدرّب/,
      /enrolment is open/i,
      /start any time/i,
      /whenever you need them/i,
      /التسجيل مفتوح/,
      /ابدأ في أي وقت/,
      /real instructors/i,
      /expert(-led)?\b/i,
      /experienced instructors/i,
      /real support/i,
      /practitioners/i,
      /mentor/i,
      /review your projects/i,
      /مدرّبين حقيقيين|مدرّبون خبراء|يقدّمها خبراء|يقوده خبراء|ذوو خبرة/,
      /دعم حقيقي/,
      /يراجع المدرّبون/,
      /every course ends with/i,
      /career/i,
      /at work/i,
      /learners recommend/i,
      /learners choose us/i,
      /ask us most/i,
      /مسيرتك المهنية/,
      /يوصي بها متعلّمونا/,
      /يختارنا المتعلّمون/,
      /في العمل/,
      /certificat/i,
      /refund/i,
      /guarantee/i,
      /شهاد/,
      /استرداد/,
      /ضمان/,
    ];
    for (const text of strings) {
      for (const pattern of banned) {
        expect({ text, matches: pattern.test(text) }).toEqual({ text, matches: false });
      }
    }
  });

  it('copy interpolates only {{academyName}}', () => {
    const tokens = JSON.stringify(atelierTemplate).match(/\{\{\w+\}\}/g) ?? [];
    expect(new Set(tokens)).toEqual(new Set(['{{academyName}}']));
  });
});

describe('Atelier template v1 — generation', () => {
  it.each(['complete', 'empty'] as const)(
    '%s mode: every page validates, CTA intents resolve, rules hold',
    async (mode) => {
      const { service, pages, page } = setup();
      const result = await service.generate(tx, ACADEMY.id, 'atelier', mode);
      expect(result).toEqual({ pagesCreated: 5, pagesSkipped: 0 });

      for (const generated of pages) {
        expect(sectionInstanceArraySchema.safeParse(generated.sections).success).toBe(
          true,
        );
      }
      expect(page('home').map((section) => section.type)).toEqual(HOME_ORDER);

      // Theme images and structure in both modes.
      const hero = page('home')[0].config;
      expect(hero.image).toBe('theme-asset:atelier/home-hero');
      expect(page('home')[1].config.image).toBe('theme-asset:atelier/home-philosophy');
      expect(page('home').at(-1)!.config.image).toBe('theme-asset:atelier/home-cta');
      const gallery = page('about').find((section) => section.type === 'gallery')!.config;
      expect((gallery.images as Row[]).map((image) => image.image)).toEqual(
        [1, 2, 3, 4, 5].map((n) => `theme-asset:atelier/gallery-${n}`),
      );

      // No hand-typed statistics in either mode.
      for (const coreType of ['home', 'about']) {
        const stats = page(coreType).find((section) => section.type === 'statistics')!;
        for (const item of stats.config.items as Row[]) {
          expect(item.metric).toBeDefined();
          expect(item.value).toEqual({ en: '', ar: '' });
        }
      }

      // CTA intents resolve to the pages just created, and to Sign Up.
      const cta = page('home').at(-1)!.config;
      expect(cta.cta).toMatchObject({ authAction: 'signUp' });
      if (mode === 'complete') {
        expect(hero.cta).toMatchObject({ pageId: 'page-courses' });
        expect(hero.secondaryCta).toMatchObject({ pageId: 'page-contact' });
        expect(page('home')[1].config.cta).toMatchObject({ pageId: 'page-about' });
        expect(cta.secondaryCta).toMatchObject({ pageId: 'page-courses' });
      }

      // Mastheads: authored in complete mode; the page's own title in empty mode.
      const aboutHeader = page('about')[0].config;
      expect(aboutHeader.image).toBe('theme-asset:atelier/about-header');
      if (mode === 'complete') {
        expect(aboutHeader.eyebrow).toEqual({
          en: 'About Cedar Academy',
          ar: 'عن Cedar Academy',
        });
      } else {
        expect(aboutHeader.title).toEqual({ en: 'About', ar: 'من نحن' });
      }
    },
  );

  it('complete mode keeps every authored field — the section schemas strip nothing', async () => {
    const { service, page } = setup();
    await service.generate(tx, ACADEMY.id, 'atelier', 'complete');
    for (const templatePage of atelierTemplate.pages) {
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
    await complete.service.generate(tx, ACADEMY.id, 'atelier', 'complete');
    const seeded = complete
      .page('home')
      .find((section) => section.type === 'testimonials')!.config.items as Row[];
    expect(seeded.map((item) => item.sample)).toEqual([true, true, true]);

    const empty = setup();
    await empty.service.generate(tx, ACADEMY.id, 'atelier', 'empty');
    const none = empty.page('home').find((section) => section.type === 'testimonials')!
      .config.items as Row[];
    expect(none).toEqual([]);
  });

  it('records template v1 provenance', async () => {
    const { service, configuration } = setup();
    await service.generate(tx, ACADEMY.id, 'atelier', 'complete');
    expect(configuration()).toMatchObject({ templateKey: 'atelier', templateVersion: 1 });
  });
});
