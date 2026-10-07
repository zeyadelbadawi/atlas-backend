/**
 * Generation output for EVERY theme × setup mode (Theme 1 plan Phase 8,
 * handover GEN-1).
 *
 * Phase 7 changed shared generation code (`emptyModeMinimum`, section
 * defaults) that every theme goes through, while only Theme 1 had an
 * output test. This runs the real `WebsiteGenerationService` with
 * in-memory repositories for every theme in both modes and checks
 * the contract every generated website must meet: each template page is
 * created, every page validates against the shared section schema, CTA
 * targets resolve to generated pages, no template token survives
 * interpolation, and a second run creates nothing. The content limits
 * (`website.constants.ts`) are part of that contract: every page must
 * validate even for an Academy whose name is as long as allowed.
 */
import type { Prisma } from '@prisma/client';
import { WebsiteBootstrapService } from './website-bootstrap.service';
import { WebsiteGenerationService } from './website-generation.service';
import { sectionInstanceArraySchema } from '../validation/section-config.schemas';
import { getWebsiteTemplate } from '../templates/website-template.registry';
import { MAX_ACADEMY_NAME_LENGTH } from '../../academy/dto/create-academy.dto';
import { MAX_HERO_TITLE_LENGTH } from '../constants/website.constants';

type Row = Record<string, unknown>;
const tx = {} as Prisma.TransactionClient;
const ACADEMY = { id: 'a1', name: 'Cedar Academy', description: 'Learn with us.' };
/** The longest names an Academy may have, in both scripts. */
const LONG_NAMES = [
  'The International Institute of Applied Digital Craft and Creative Leadership Studies of Alexandria'.padEnd(
    MAX_ACADEMY_NAME_LENGTH,
    'x',
  ),
  'المعهد الدولي للحرف الرقمية التطبيقية والقيادة الإبداعية والدراسات المتقدمة في الإسكندرية'.padEnd(
    MAX_ACADEMY_NAME_LENGTH,
    'ة',
  ),
];

const THEMES = [
  'modern-education',
  'atelier',
  'manara',
  'riwaq',
  'premium-academy',
  'corporate-learning',
  'minimal-editorial',
  'bold-creative',
] as const;
const MODES = ['complete', 'empty'] as const;

function setup(academy: typeof ACADEMY = ACADEMY) {
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
    { findById: async () => academy } as never,
    configurationRepository as never,
    pagesRepository as never,
    new WebsiteBootstrapService(
      configurationRepository as never,
      pagesRepository as never,
    ),
  );
  return { service, pages, configuration: () => configuration };
}

/** Every `pageId` anywhere in `value`. */
function pageIds(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, entry] of Object.entries(node)) {
      if (key === 'pageId' && typeof entry === 'string') found.push(entry);
      walk(entry);
    }
  };
  walk(value);
  return found;
}

describe('Website generation — every theme × setup mode', () => {
  const cases = THEMES.flatMap((theme) => MODES.map((mode) => [theme, mode] as const));

  it.each(cases)(
    '%s / %s: pages validate, links resolve, no tokens left',
    async (theme, mode) => {
      const { service, pages, configuration } = setup();
      const template = getWebsiteTemplate(theme);

      const result = await service.generate(tx, ACADEMY.id, theme, mode);
      expect(result).toEqual({ pagesCreated: template.pages.length, pagesSkipped: 0 });
      expect(pages.map((page) => page.coreType)).toEqual(
        template.pages.map((page) => page.coreType),
      );

      for (const page of pages) {
        const parsed = sectionInstanceArraySchema.safeParse(page.sections);
        expect({ page: page.coreType, ok: parsed.success }).toEqual({
          page: page.coreType,
          ok: true,
        });
        expect((page.sections as unknown[]).length).toBeGreaterThan(0);
      }

      // Every CTA / navigation target is a page this run generated.
      const ids = new Set(pages.map((page) => page.id));
      for (const id of [...pageIds(pages), ...pageIds(configuration())]) {
        expect(ids.has(id)).toBe(true);
      }

      // Interpolation left nothing behind in pages or configuration.
      expect(JSON.stringify(pages)).not.toMatch(/\{\{\w+\}\}/);
      expect(JSON.stringify(configuration())).not.toMatch(/\{\{\w+\}\}/);

      // Idempotent: the second run keeps every page and creates none.
      const again = await service.generate(tx, ACADEMY.id, theme, mode);
      expect(again).toEqual({ pagesCreated: 0, pagesSkipped: template.pages.length });
      expect(pages).toHaveLength(template.pages.length);
    },
  );

  it.each(
    THEMES.flatMap((theme) =>
      MODES.flatMap((mode) => LONG_NAMES.map((name) => [theme, mode, name] as const)),
    ),
  )(
    '%s / %s: a maximum-length name still fits every limit (%s)',
    async (theme, mode, name) => {
      const { service, pages } = setup({ ...ACADEMY, name });
      await service.generate(tx, ACADEMY.id, theme, mode);

      expect(pages.length).toBe(getWebsiteTemplate(theme).pages.length);
      for (const page of pages) {
        const parsed = sectionInstanceArraySchema.safeParse(page.sections);
        expect({ page: page.coreType, issues: parsed.error?.issues ?? [] }).toEqual({
          page: page.coreType,
          issues: [],
        });
      }
      const home = pages.find((page) => page.coreType === 'home')!;
      const hero = (
        home.sections as { type: string; config: { title: { en: string } } }[]
      ).find((section) => section.type === 'hero');
      expect(hero?.config.title.en.length).toBeLessThanOrEqual(MAX_HERO_TITLE_LENGTH);
    },
  );

  it.each(['modern-education', 'atelier', 'manara', 'riwaq'] as const)(
    'complete mode does carry %s samples (the check below is not vacuous)',
    async (theme) => {
      const { service, pages } = setup();
      await service.generate(tx, ACADEMY.id, theme, 'complete');
      expect(JSON.stringify(pages)).toMatch(/"sample":true/);
    },
  );

  it.each(THEMES)('%s: empty mode carries no sample content', async (theme) => {
    const { service, pages } = setup();
    await service.generate(tx, ACADEMY.id, theme, 'empty');
    expect(JSON.stringify(pages)).not.toMatch(/"sample":true/);
  });
});
