/**
 * WebsiteBootstrapService — lazily provisions an Academy's
 * `website_configurations` row and its six core `website_pages` rows the
 * first time either is read.
 *
 * No dedicated "create website" endpoint exists anywhere in the real
 * `WebsiteConfigurationService` contract (`getConfiguration`/`getPages`
 * are called unconditionally by `WebsiteOverviewPage`/`useWebsiteConfiguration`
 * the moment an Academy's website surface is opened, with no prior
 * "initialize" step) — this get-or-create-on-read is the only way to
 * satisfy that contract without inventing an endpoint the frontend never
 * calls.
 *
 * Idempotent under concurrent first-reads: each create is wrapped so a
 * `P2002` unique-constraint race (two requests bootstrapping the same
 * Academy at once) is treated as "someone else just created it," not an
 * error — the caller always gets back the one real row either way.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Prisma as PrismaNS,
  WebsiteConfiguration,
  WebsitePage,
} from '@prisma/client';
import { WebsiteConfigurationRepository } from '../repositories/website-configuration.repository';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import {
  DEFAULT_BRAND_COLOR,
  WEBSITE_CORE_PAGE_TYPES,
  WEBSITE_THEME_KEYS,
} from '../constants/website.constants';

const CORE_PAGE_DEFAULTS: Record<
  (typeof WEBSITE_CORE_PAGE_TYPES)[number],
  { readonly title: string; readonly slug: string }
> = {
  home: { title: 'Home', slug: 'home' },
  about: { title: 'About', slug: 'about' },
  courses: { title: 'Courses', slug: 'courses' },
  faqs: { title: 'FAQs', slug: 'faqs' },
  contact: { title: 'Contact', slug: 'contact' },
  courseDetails: { title: 'Course Details', slug: 'course-details' },
};

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class WebsiteBootstrapService {
  constructor(
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websitePagesRepository: WebsitePagesRepository,
  ) {}

  async ensureConfiguration(
    tx: PrismaNS.TransactionClient,
    academyId: string,
  ): Promise<WebsiteConfiguration> {
    const existing = await this.websiteConfigurationRepository.findByAcademyId(
      tx,
      academyId,
    );
    if (existing) return existing;

    try {
      return await this.websiteConfigurationRepository.create(tx, {
        academy: { connect: { id: academyId } },
        themeKey: WEBSITE_THEME_KEYS[0],
        themeVersion: 1,
        configVersion: 1,
        brand: {
          primaryColor: DEFAULT_BRAND_COLOR,
          secondaryColor: DEFAULT_BRAND_COLOR,
          accentColor: DEFAULT_BRAND_COLOR,
        },
        seo: {},
        navigation: [],
        header: {},
        footer: { groups: [], socialLinks: [] },
        status: 'draft',
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const raced = await this.websiteConfigurationRepository.findByAcademyId(
        tx,
        academyId,
      );
      if (!raced) throw error;
      return raced;
    }
  }

  async ensureCorePages(
    tx: PrismaNS.TransactionClient,
    academyId: string,
  ): Promise<WebsitePage[]> {
    const existing = await this.websitePagesRepository.findAllCore(tx, academyId);
    const existingTypes = new Set(existing.map((page) => page.coreType));
    const missing = WEBSITE_CORE_PAGE_TYPES.filter((type) => !existingTypes.has(type));

    if (missing.length === 0) return existing;

    for (const coreType of missing) {
      const defaults = CORE_PAGE_DEFAULTS[coreType];
      try {
        await this.websitePagesRepository.create(tx, {
          academy: { connect: { id: academyId } },
          pageType: 'core',
          coreType,
          title: defaults.title,
          slug: defaults.slug,
          visible: true,
          seo: {},
          sections: [],
        });
      } catch (error) {
        // Another concurrent first-read already created this exact core
        // page — not a real conflict, nothing further to do.
        if (!isUniqueConstraintViolation(error)) throw error;
      }
    }

    return this.websitePagesRepository.findAllCore(tx, academyId);
  }

  async ensureBootstrapped(
    tx: PrismaNS.TransactionClient,
    academyId: string,
  ): Promise<{ configuration: WebsiteConfiguration; corePages: WebsitePage[] }> {
    const configuration = await this.ensureConfiguration(tx, academyId);
    const corePages = await this.ensureCorePages(tx, academyId);
    return { configuration, corePages };
  }
}
