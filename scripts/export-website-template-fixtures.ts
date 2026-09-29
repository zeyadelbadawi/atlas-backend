/**
 * Theme 1 plan, Phase 0 — exports the website each theme's template
 * generates for a brand-new Academy, as frontend render fixtures.
 *
 * The frontend's theme baseline (screenshots, axe, Lighthouse) must render
 * exactly what a real Academy gets on day one, not a hand-written copy of it
 * that drifts every time a template changes. So this runs the REAL
 * `WebsiteGenerationService.generate` (and the real
 * `WebsiteBootstrapService.ensureConfiguration` it calls) against in-memory
 * repositories instead of PostgreSQL, then serialises the result through the
 * real response mappers (`toWebsitePageResponse` /
 * `toWebsiteConfigurationResponse`) — the same shape the public API returns.
 *
 * Nothing touches a database, and no application code path changes: this is
 * development tooling only.
 *
 * Determinism (the output is committed and diffed):
 *   - every generated UUID is renamed, in order of first appearance, to a
 *     stable `fx-<theme>-<n>` id;
 *   - the clock is pinned to FIXED_NOW, so timestamps and the footer's
 *     copyright year never change between runs.
 *
 * Usage:
 *   npm run fixtures:website-templates -- <output-dir>
 *   (the frontend keeps them in `e2e/theme-baseline/fixtures/generated/`)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { WebsiteGenerationService } from '../src/website/services/website-generation.service';
import { WebsiteBootstrapService } from '../src/website/services/website-bootstrap.service';
import { toWebsitePageResponse } from '../src/website/dto/website-page.contract';
import { toWebsiteConfigurationResponse } from '../src/website/dto/website-configuration.contract';
import { WEBSITE_THEME_KEYS } from '../src/website/constants/website.constants';
import type { WebsiteTemplateThemeKey } from '../src/website/templates/website-template.types';

const FIXED_NOW = new Date('2026-09-01T09:00:00.000Z');
const ACADEMY_ID = 'fx-academy';
const ACADEMY = {
  id: ACADEMY_ID,
  name: 'Horizon Academy',
  description: 'Practical, mentor-led courses for ambitious learners.',
};

/** Pins `new Date()` / `Date.now()` so generated timestamps and the footer year are stable. */
function pinClock(): void {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FIXED_NOW.getTime());
      } else {
        super(...(args as [string]));
      }
    }
    static now(): number {
      return FIXED_NOW.getTime();
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
}

type Row = Record<string, unknown>;

/** The minimum of each repository `generate`/`ensureConfiguration` call, backed by plain objects. */
function createInMemoryRepositories() {
  let configuration: Row | null = null;
  const pages: Row[] = [];
  let nextPageId = 0;

  const withoutRelation = (data: Row): Row => {
    const { academy: _academy, ...rest } = data;
    return rest;
  };

  const academiesRepository = {
    findById: async (_tx: unknown, id: string) => (id === ACADEMY.id ? ACADEMY : null),
  };

  const websiteConfigurationRepository = {
    findByAcademyId: async () => configuration,
    create: async (_tx: unknown, data: Row) => {
      configuration = {
        ...withoutRelation(data),
        academyId: ACADEMY_ID,
        publishedAt: null,
        lastPublishError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return configuration;
    },
    update: async (_tx: unknown, _academyId: string, data: Row) => {
      configuration = { ...configuration!, ...data, updatedAt: new Date() };
      return configuration;
    },
  };

  const websitePagesRepository = {
    findCoreByType: async (_tx: unknown, _academyId: string, coreType: string) =>
      pages.find((page) => page.coreType === coreType) ?? null,
    findById: async (_tx: unknown, _academyId: string, id: string) =>
      pages.find((page) => page.id === id) ?? null,
    findAllCore: async () => pages.filter((page) => page.pageType === 'core'),
    create: async (_tx: unknown, data: Row) => {
      nextPageId += 1;
      const page: Row = {
        ...withoutRelation(data),
        id: `page-${nextPageId}`,
        academyId: ACADEMY_ID,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      pages.push(page);
      return page;
    },
    update: async (_tx: unknown, id: string, data: Row) => {
      const index = pages.findIndex((page) => page.id === id);
      pages[index] = { ...pages[index], ...data, updatedAt: new Date() };
      return pages[index];
    },
  };

  return {
    academiesRepository,
    websiteConfigurationRepository,
    websitePagesRepository,
    read: () => ({ configuration, pages }),
  };
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Renames every UUID (and the in-memory `page-<n>` ids) to stable, readable ids, in order of first appearance. */
function stabiliseIds(json: string, themeKey: string): string {
  const renamed = new Map<string, string>();
  return json.replace(new RegExp(`${UUID_PATTERN.source}|page-\\d+`, 'g'), (id) => {
    if (!renamed.has(id)) {
      const prefix = id.startsWith('page-') ? 'page' : 'item';
      renamed.set(id, `fx-${themeKey}-${prefix}-${renamed.size + 1}`);
    }
    return renamed.get(id)!;
  });
}

async function exportTheme(themeKey: WebsiteTemplateThemeKey): Promise<string> {
  const repositories = createInMemoryRepositories();
  const bootstrap = new WebsiteBootstrapService(
    repositories.websiteConfigurationRepository as never,
    repositories.websitePagesRepository as never,
  );
  const generation = new WebsiteGenerationService(
    repositories.academiesRepository as never,
    repositories.websiteConfigurationRepository as never,
    repositories.websitePagesRepository as never,
    bootstrap,
  );

  // Provisioning's own order (`executeThemeStep`): the theme key is persisted
  // first, then the template is generated in `'complete'` mode — the mode
  // the setup form pre-selects.
  await bootstrap.ensureConfiguration({} as Prisma.TransactionClient, ACADEMY_ID);
  await repositories.websiteConfigurationRepository.update({}, ACADEMY_ID, { themeKey });
  await generation.generate(
    {} as Prisma.TransactionClient,
    ACADEMY_ID,
    themeKey,
    'complete',
  );
  // The Owner then opens the Website tab (required to publish), whose first
  // read runs `ensureBootstrapped` — that is what adds the Course Details
  // core page the templates themselves don't declare.
  await bootstrap.ensureBootstrapped({} as Prisma.TransactionClient, ACADEMY_ID);

  const { configuration, pages } = repositories.read();
  const fixture = {
    generatedBy: 'atlas-backend scripts/export-website-template-fixtures.ts',
    themeKey,
    setupMode: 'complete',
    academy: { academyId: ACADEMY.id, academyName: ACADEMY.name },
    configuration: toWebsiteConfigurationResponse(configuration as never),
    pages: pages.map((page) => toWebsitePageResponse(page as never)),
  };
  return stabiliseIds(`${JSON.stringify(fixture, null, 2)}\n`, themeKey);
}

async function main(): Promise<void> {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error('Usage: npm run fixtures:website-templates -- <output-dir>');
    process.exit(1);
  }
  pinClock();
  const target = resolve(outputDir);
  mkdirSync(target, { recursive: true });
  for (const themeKey of WEBSITE_THEME_KEYS) {
    const file = join(target, `${themeKey}.json`);
    writeFileSync(file, await exportTheme(themeKey));
    console.log(`wrote ${file}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
