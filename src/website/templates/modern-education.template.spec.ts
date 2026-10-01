/**
 * Theme 1 starter content — template v2 (plan Phase 7, §C and §D.4).
 *
 * The template data itself (composition, sample and live-data rules,
 * asset references), then both generation modes through the real
 * `WebsiteGenerationService` with in-memory repositories: every generated
 * page validates, CTA intents resolve, and the rules hold after
 * generation. Idempotency and Owner-edit preservation against a real
 * database are covered by the provisioning e2e.
 */
import type { Prisma } from '@prisma/client';
import { WebsiteBootstrapService } from '../services/website-bootstrap.service';
import { WebsiteGenerationService } from '../services/website-generation.service';
import { sectionInstanceArraySchema } from '../validation/section-config.schemas';
import { getWebsiteTemplate } from './website-template.registry';
import { modernEducationTemplate } from './modern-education.template';

type Row = Record<string, unknown>;
type Section = { type: string; config: Record<string, unknown> };
const tx = {} as Prisma.TransactionClient;
const ACADEMY = { id: 'a1', name: 'Cedar Academy', description: null };

const HOME_ORDER = [
  'hero',
  'features',
  'courseCategories',
  'featuredCourses',
  'featureSplit',
  'steps',
  'instructors',
  'statistics',
  'testimonials',
  'faq',
  'cta',
];

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

describe('Theme 1 template v2 — the template', () => {
  it('is version 2 and the registry serves it for modern-education', () => {
    expect(modernEducationTemplate.version).toBe(2);
    expect(getWebsiteTemplate('modern-education')).toBe(modernEducationTemplate);
  });

  it('composes Home per §C.1 and gives every inner page its own page hero first (§C.0)', () => {
    const byType = Object.fromEntries(
      modernEducationTemplate.pages.map((page) => [page.coreType, page.sections]),
    );
    expect(Object.keys(byType)).toEqual(['home', 'about', 'courses', 'faqs', 'contact']);
    expect(byType.home.map((section) => section.type)).toEqual(HOME_ORDER);
    for (const coreType of ['about', 'courses', 'faqs', 'contact']) {
      expect(byType[coreType][0].type).toBe('pageHeader');
    }
    expect(byType.courses[0].dynamicDefaults).toMatchObject({ search: 'courses' });
    expect(byType.faqs[0].dynamicDefaults).toMatchObject({ search: 'faq' });
  });

  it('statistics are metric-only: no authored number anywhere in the template (§D.4)', () => {
    const items = modernEducationTemplate.pages.flatMap((page) =>
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

  it('testimonials are samples with initials only — no photos of people (§D.4)', () => {
    const testimonials = modernEducationTemplate.pages
      .flatMap((page) => page.sections)
      .filter((section) => section.type === 'testimonials');
    const items = testimonials.flatMap(
      (section) => (section.starterContent?.items as Row[]) ?? [],
    );
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sample).toBe(true);
      expect(item.avatar).toBeUndefined();
    }
  });

  it('every image is a Theme 1 asset reference, and theme images live in `assets` (both modes)', () => {
    const images = collect(modernEducationTemplate, (key) => key === 'image');
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(/^theme-asset:modern-education\/[a-z0-9-]+$/);
    }
    for (const section of modernEducationTemplate.pages.flatMap(
      (page) => page.sections,
    )) {
      expect(collect(section.starterContent ?? {}, (key) => key === 'image')).toEqual([]);
    }
  });

  it('starter copy makes no claim an Academy may not be able to keep (EN and AR)', () => {
    // Sample testimonials are preview-only (§D.4) and never served, so they
    // are not starter claims; every other authored string is.
    const strings = collect(
      modernEducationTemplate.pages.map((page) =>
        page.sections.map((section) => ({
          ...section,
          starterContent: {
            ...section.starterContent,
            items: Array.isArray(section.starterContent?.items)
              ? (section.starterContent.items as Row[]).filter((item) => !item.sample)
              : section.starterContent?.items,
          },
        })),
      ),
      (key, value) => (key === 'en' || key === 'ar') && typeof value === 'string',
    ) as string[];
    expect(strings.length).toBeGreaterThan(50);

    const banned = [
      // pricing / free access
      /some courses are free/i,
      /free (preview|account|course)/i,
      /pay securely/i,
      /بعض الدورات مجانية/,
      /مجاني/,
      /بأمان عبر الإنترنت/,
      // previews
      /preview lessons\. open/i,
      /دروس معاينة مجانية/,
      // response times / who answers
      /get back to you/i,
      /we will reply/i,
      /answered by the instructor/i,
      /point you to the right course/i,
      /سيعود إليك|سنعود إليك|وسنردّ عليك|وسنرشدك/,
      /يجيب المدرّب/,
      // availability
      /enrolment is open/i,
      /start any time/i,
      /whenever you need them/i,
      /التسجيل مفتوح/,
      /ابدأ في أي وقت/,
      // instructor quality / support claims
      /real instructors/i,
      /expert(-led)?\b/i,
      /experienced instructors/i,
      /real support/i,
      /practitioners/i,
      /review your projects/i,
      /مدرّبين حقيقيين|مدرّبون خبراء|يقدّمها خبراء|يقوده خبراء|ذوو خبرة/,
      /دعم حقيقي/,
      /يراجع المدرّبون/,
      // projects, outcomes, careers, social proof
      /every course ends with/i,
      /finish every course able/i,
      /career/i,
      /at work/i,
      /learners recommend/i,
      /learners choose us/i,
      /ask us most/i,
      /مسيرتك المهنية/,
      /يوصي بها متعلّمونا/,
      /يختارنا المتعلّمون/,
      /في العمل/,
      // certificates, refunds, guarantees
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
    const tokens = JSON.stringify(modernEducationTemplate).match(/\{\{\w+\}\}/g) ?? [];
    expect(new Set(tokens)).toEqual(new Set(['{{academyName}}']));
  });

  it('Themes 2–5 keep their v1 templates (no version, shared support pages)', () => {
    for (const key of [
      'premium-academy',
      'corporate-learning',
      'minimal-editorial',
      'bold-creative',
    ] as const) {
      const template = getWebsiteTemplate(key);
      expect(template.version).toBeUndefined();
      const about = template.pages.find((page) => page.coreType === 'about')!;
      expect(about.sections.map((section) => section.type)).toEqual(['about']);
    }
  });
});

describe('Theme 1 template v2 — generation', () => {
  it.each(['complete', 'empty'] as const)(
    '%s mode: every page validates, CTA intents resolve, rules hold',
    async (mode) => {
      const { service, pages, page } = setup();
      const result = await service.generate(tx, ACADEMY.id, 'modern-education', mode);
      expect(result).toEqual({ pagesCreated: 5, pagesSkipped: 0 });

      for (const generated of pages) {
        expect(sectionInstanceArraySchema.safeParse(generated.sections).success).toBe(
          true,
        );
      }
      expect(page('home').map((section) => section.type)).toEqual(HOME_ORDER);

      // Theme images and structure in both modes.
      const hero = page('home')[0].config;
      expect(hero.image).toBe('theme-asset:modern-education/home-hero');
      expect(hero.showSearch).toBe(true);
      const gallery = page('about').find((section) => section.type === 'gallery')!.config;
      expect((gallery.images as Row[]).map((image) => image.image)).toEqual(
        [1, 2, 3, 4, 5].map((n) => `theme-asset:modern-education/gallery-${n}`),
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
        expect(cta.secondaryCta).toMatchObject({ pageId: 'page-courses' });
      }

      // Page heroes: authored in complete mode; the page's own title in empty mode.
      const aboutHero = page('about')[0].config;
      if (mode === 'complete') {
        expect(aboutHero.eyebrow).toEqual({
          en: 'About Cedar Academy',
          ar: 'عن Cedar Academy',
        });
      } else {
        expect(aboutHero.title).toEqual({ en: 'About', ar: 'من نحن' });
        expect(aboutHero.image).toBe('theme-asset:modern-education/about-header');
      }
    },
  );

  it('complete mode seeds exactly three sample testimonials; empty mode seeds none', async () => {
    const complete = setup();
    await complete.service.generate(tx, ACADEMY.id, 'modern-education', 'complete');
    const seeded = complete
      .page('home')
      .find((section) => section.type === 'testimonials')!.config.items as Row[];
    expect(seeded.map((item) => item.sample)).toEqual([true, true, true]);

    const empty = setup();
    await empty.service.generate(tx, ACADEMY.id, 'modern-education', 'empty');
    const none = empty.page('home').find((section) => section.type === 'testimonials')!
      .config.items as Row[];
    expect(none).toEqual([]);
  });

  it('records template v2 provenance', async () => {
    const { service, configuration } = setup();
    await service.generate(tx, ACADEMY.id, 'modern-education', 'complete');
    expect(configuration()).toMatchObject({
      templateKey: 'modern-education',
      templateVersion: 2,
    });
  });
});
