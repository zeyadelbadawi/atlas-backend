/**
 * WebsiteGenerationService — Phase 6 (Bilingual Academy Websites).
 *
 * Turns a theme choice into a genuinely usable website at provisioning
 * time, instead of the six-empty-pages shell `WebsiteBootstrapService`'s
 * lazy path produces. Called from the provisioning orchestrator's
 * existing `'theme'` step (`executeThemeStep`) — never a new orchestrator
 * step, never a second theme-persistence mechanism (see that method's own
 * doc comment).
 *
 * Two modes, one code path:
 *   - `'empty'`  — every page/section from the theme's own
 *     `WebsiteTemplateDefinition` is created, every REQUIRED field gets a
 *     minimal, honest, theme-agnostic default (never a placeholder that
 *     reads as fake data), every OPTIONAL field is left blank. A real,
 *     structured shell — never a page with zero sections.
 *   - `'complete'` — the same structure, additionally filled with the
 *     theme's own authored, bilingual `starterContent`.
 * In BOTH modes, every section type that already supports live data
 * (`featuredCourses`, `statistics`, `instructors`, `contact` —
 * `section-config.schemas.ts`) is generated with that live-data
 * CONFIGURATION (e.g. `{ metric: 'courses' }`), never a fabricated
 * snapshot number — the number shown is always real, on day one and a
 * year later, with zero extra code (see `section-config.schemas.ts`'s own
 * doc comment on this same principle).
 *
 * Idempotent by construction, matching `WebsiteBootstrapService.
 * ensureCorePages`'s own pattern exactly: a page that already exists
 * (any prior attempt, any prior read) is left completely untouched — an
 * Owner's real edits can never be overwritten by a retried/redelivered
 * generation call. `WebsiteConfiguration.navigation`/`footer` are
 * similarly only ever written into while still at their untouched
 * bootstrap default (`[]` / `{groups: [], socialLinks: []}`).
 *
 * The existing lazy `ensureCorePages()` path is NOT removed or
 * bypassed — it remains the correct safety net for any Academy that
 * reaches the Website tab without a `selectedThemeKey` at all (see
 * `executeThemeStep`), or one created before this phase shipped.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Prisma as PrismaNS } from '@prisma/client';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { WebsiteConfigurationRepository } from '../repositories/website-configuration.repository';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import { WebsiteBootstrapService, CORE_PAGE_DEFAULTS } from './website-bootstrap.service';
import { getWebsiteTemplate } from '../templates/website-template.registry';
import { sectionInstanceArraySchema } from '../validation/section-config.schemas';
import { interpolate, interpolateLocalized, lt, type TemplateInterpolationContext } from '../templates/template-content.util';
import type { LocalizedTextLike } from '../utils/localized-text.util';
import type {
  SectionType,
  WebsiteTemplateCorePageType,
  WebsiteTemplateSection,
  WebsiteTemplateThemeKey,
} from '../templates/website-template.types';
import type { WEBSITE_SETUP_MODES } from '../constants/website.constants';

type WebsiteSetupMode = (typeof WEBSITE_SETUP_MODES)[number];

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isLocalizedTextLike(value: unknown): value is LocalizedTextLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).en === 'string' &&
    typeof (value as Record<string, unknown>).ar === 'string'
  );
}

/** Walks an arbitrary starter-content object, interpolating every `LocalizedText` leaf it finds — the one place `{{academyName}}`/`{{academyDescription}}` tokens are resolved, regardless of how deeply nested (a top-level field, an item inside a repeatable array, a nested `cta.label`). */
function deepInterpolate(value: unknown, context: TemplateInterpolationContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => deepInterpolate(entry, context));
  if (isLocalizedTextLike(value)) return interpolateLocalized(value, context);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        deepInterpolate(entry, context),
      ]),
    );
  }
  return value;
}

/**
 * The one-time, theme-agnostic minimum every REQUIRED field needs in
 * `'empty'` mode — never per-theme (a theme's personality shows through
 * structure/composition, §5, not through placeholder wording), never a
 * fabricated specific claim, always either a generic instruction to the
 * Owner or a real interpolated Academy fact.
 */
const EMPTY_MODE_MINIMUMS: Partial<Record<SectionType, Record<string, unknown>>> = {
  hero: { title: lt('{{academyName}}') },
  about: {
    title: lt('About {{academyName}}', 'نبذة عن {{academyName}}'),
    body: lt(
      "Tell your students about your academy here.",
      'أخبر طلابك عن أكاديميتك هنا.',
    ),
  },
  featuredCourses: { title: lt('Our Courses', 'دوراتنا') },
  cta: {
    title: lt('Get Started', 'ابدأ الآن'),
    cta: { label: lt('Learn More', 'اعرف المزيد') },
  },
};

/**
 * A schema-required key ALWAYS needs to be present, in every mode, even
 * when there's genuinely nothing to put in it yet — an absent `items`
 * key fails validation ("Required") the same way a missing `title`
 * would, even though the array itself has no minimum length. Applied
 * before `dynamicDefaults`/`starterContent`/`EMPTY_MODE_MINIMUMS`, so any
 * of those can still override it with real content.
 */
const SECTION_BASE_DEFAULTS: Partial<Record<SectionType, Record<string, unknown>>> = {
  features: { items: [] },
  testimonials: { items: [] },
  faq: { items: [] },
  gallery: { images: [] },
};

export interface WebsiteGenerationResult {
  readonly pagesCreated: number;
  readonly pagesSkipped: number;
}

@Injectable()
export class WebsiteGenerationService {
  private readonly logger = new Logger(WebsiteGenerationService.name);

  constructor(
    private readonly academiesRepository: AcademiesRepository,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly websiteBootstrapService: WebsiteBootstrapService,
  ) {}

  /** Builds one section's `config`, applying dynamic defaults (both modes) plus either interpolated starter content (`'complete'`) or the generic minimal default (`'empty'`) — never both, never neither for a field that needs one. */
  private buildSectionConfig(
    section: WebsiteTemplateSection,
    mode: WebsiteSetupMode,
    context: TemplateInterpolationContext,
  ): Record<string, unknown> {
    const base = {
      ...(SECTION_BASE_DEFAULTS[section.type] ?? {}),
      ...(section.dynamicDefaults ?? {}),
    };

    if (mode === 'complete' && section.starterContent) {
      return { ...base, ...(deepInterpolate(section.starterContent, context) as Record<string, unknown>) };
    }

    const minimal = EMPTY_MODE_MINIMUMS[section.type];
    if (minimal) {
      return { ...base, ...(deepInterpolate(minimal, context) as Record<string, unknown>) };
    }

    return base;
  }

  /**
   * Generates the theme's full page/section set for an Academy that just
   * had `themeKey` applied — called from `executeThemeStep`, always
   * AFTER `WebsiteConfigurationService.updateConfiguration` has already
   * persisted the theme itself. Never called with no theme selected (see
   * that method's own doc comment) — generation without a real theme
   * choice would have nothing to generate FROM.
   */
  async generate(
    tx: PrismaNS.TransactionClient,
    academyId: string,
    themeKey: WebsiteTemplateThemeKey,
    mode: WebsiteSetupMode,
  ): Promise<WebsiteGenerationResult> {
    const academy = await this.academiesRepository.findById(tx, academyId);
    if (!academy) {
      // Structurally unreachable in normal operation (the 'academy' step
      // always runs before 'theme' — see `executeThemeStep`'s own doc
      // comment) — defensive, never a hard failure of the provisioning
      // request itself.
      this.logger.warn(`WebsiteGenerationService.generate called for unknown academyId=${academyId}`);
      return { pagesCreated: 0, pagesSkipped: 0 };
    }

    const context: TemplateInterpolationContext = {
      academyName: academy.name,
      academyDescription: academy.description ?? undefined,
    };
    const template = getWebsiteTemplate(themeKey);

    // Configuration must already exist (or is created here) before pages
    // reference it — same lazy-create-if-missing guard `updateConfiguration`
    // itself already relies on.
    await this.websiteBootstrapService.ensureConfiguration(tx, academyId);

    let pagesCreated = 0;
    let pagesSkipped = 0;
    const pageIdByCoreType = new Map<WebsiteTemplateCorePageType, string>();
    const freshlyCreatedPageIds = new Set<string>();

    // Pass 1 — create every page that doesn't already exist. CTA targets
    // that reference the id of a page created later in this same pass
    // (e.g. Home's Hero button pointing at Courses) are deliberately left
    // unresolved here (`pageId`/`authAction` omitted — a CTA with just a
    // label is valid, simply not yet wired) and patched in Pass 2, once
    // every page's real id is known.
    for (const templatePage of template.pages) {
      const existing = await this.websitePagesRepository.findCoreByType(tx, academyId, templatePage.coreType);
      if (existing) {
        pageIdByCoreType.set(templatePage.coreType, existing.id);
        pagesSkipped += 1;
        continue;
      }

      const defaults = CORE_PAGE_DEFAULTS[templatePage.coreType];
      const sections = templatePage.sections.map((templateSection) => ({
        id: randomUUID(),
        type: templateSection.type,
        enabled: true,
        visibility: { desktop: true, tablet: true, mobile: true },
        config: this.buildSectionConfig(templateSection, mode, context),
      }));

      // Defensive: a template-authoring mistake must fail loudly at
      // generation time, never silently write a shape the real editor /
      // renderer would then choke on for a real Academy.
      const validated = sectionInstanceArraySchema.safeParse(sections);
      if (!validated.success) {
        this.logger.error(
          `Website template '${themeKey}' produced an invalid '${templatePage.coreType}' page: ${validated.error.message}`,
        );
        throw new Error(`Invalid generated section configuration for theme '${themeKey}'`);
      }

      try {
        const created = await this.websitePagesRepository.create(tx, {
          academy: { connect: { id: academyId } },
          pageType: 'core',
          coreType: templatePage.coreType,
          title: defaults.title,
          slug: defaults.slug,
          visible: true,
          seo: {},
          sections: validated.data,
        });
        pageIdByCoreType.set(templatePage.coreType, created.id);
        freshlyCreatedPageIds.add(created.id);
        pagesCreated += 1;
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
        // Another concurrent/redelivered attempt just created this exact
        // page — genuinely idempotent, not a real conflict.
        const raced = await this.websitePagesRepository.findCoreByType(tx, academyId, templatePage.coreType);
        if (raced) {
          pageIdByCoreType.set(templatePage.coreType, raced.id);
          pagesSkipped += 1;
        } else {
          throw error;
        }
      }
    }

    // Pass 2 — resolve `ctaTargets` on the pages THIS call actually
    // created (never touching a pre-existing page, even to "fix" a CTA —
    // an Owner's own edit to that same button must never be overwritten).
    for (const templatePage of template.pages) {
      const pageId = pageIdByCoreType.get(templatePage.coreType);
      if (!pageId || !freshlyCreatedPageIds.has(pageId)) continue;
      await this.resolveCtaTargets(tx, academyId, pageId, templatePage.sections, pageIdByCoreType);
    }

    await this.generateNavigation(tx, academyId, pageIdByCoreType);
    if (mode === 'complete') {
      await this.generateFooterAndHeaderCta(tx, academyId, context, pageIdByCoreType);
    }

    return { pagesCreated, pagesSkipped };
  }

  /** Patches `cta`/`secondaryCta.pageId` (or `.authAction` for Sign In/Sign Up) on a freshly created page's own sections, now that every core page's real id is known. A no-op section (no `ctaTargets`) is untouched. */
  private async resolveCtaTargets(
    tx: PrismaNS.TransactionClient,
    academyId: string,
    pageId: string,
    templateSections: readonly WebsiteTemplateSection[],
    pageIdByCoreType: ReadonlyMap<WebsiteTemplateCorePageType, string>,
  ): Promise<void> {
    if (!templateSections.some((section) => section.ctaTargets)) return;

    const page = await this.websitePagesRepository.findById(tx, academyId, pageId);
    if (!page) return;

    const sections = (page.sections as unknown as Array<{ id: string; config: Record<string, unknown> }>).map(
      (instance, index) => {
        const templateSection = templateSections[index];
        if (!templateSection?.ctaTargets) return instance;

        const config = { ...instance.config };
        for (const [field, target] of Object.entries(templateSection.ctaTargets)) {
          const cta = config[field] as Record<string, unknown> | undefined;
          if (!cta) continue;
          config[field] =
            target === 'signIn' || target === 'signUp'
              ? { ...cta, authAction: target }
              : { ...cta, pageId: pageIdByCoreType.get(target) };
        }
        return { ...instance, config };
      },
    );

    await this.websitePagesRepository.update(tx, pageId, { sections: sections as unknown as Prisma.InputJsonValue });
  }

  /**
   * Structural, both modes: a real website needs working navigation
   * regardless of how much copy has been filled in yet. Links to About/
   * Courses/FAQs/Contact by their own real page title (Home is reached
   * via the logo/brand mark, the standard convention `WebsiteHeader`
   * itself already follows) — never invented labels. Only ever writes
   * while `navigation` is still at its untouched bootstrap default
   * (`[]`) — an Owner's own nav customization is never overwritten by a
   * retried/redelivered generation call.
   */
  private async generateNavigation(
    tx: PrismaNS.TransactionClient,
    academyId: string,
    pageIdByCoreType: ReadonlyMap<WebsiteTemplateCorePageType, string>,
  ): Promise<void> {
    const configuration = await this.websiteConfigurationRepository.findByAcademyId(tx, academyId);
    if (!configuration || (configuration.navigation as unknown[]).length > 0) return;

    const navPages: readonly WebsiteTemplateCorePageType[] = ['about', 'courses', 'faqs', 'contact'];
    const navigation = navPages
      .filter((coreType) => pageIdByCoreType.has(coreType))
      .map((coreType, index) => ({
        id: randomUUID(),
        label: { en: CORE_PAGE_DEFAULTS[coreType].title, ar: '' },
        pageId: pageIdByCoreType.get(coreType)!,
        order: index,
      }));

    if (navigation.length === 0) return;
    await this.websiteConfigurationRepository.update(tx, academyId, {
      navigation: navigation as unknown as Prisma.InputJsonValue,
    });
  }

  /**
   * Polish, `'complete'` mode only: a footer "Quick Links" group mirroring
   * the same navigation, a real copyright line, and a header Sign Up CTA
   * — matching "the complete experience required for that theme." Same
   * only-while-untouched idempotency guard as `generateNavigation`.
   */
  private async generateFooterAndHeaderCta(
    tx: PrismaNS.TransactionClient,
    academyId: string,
    context: TemplateInterpolationContext,
    pageIdByCoreType: ReadonlyMap<WebsiteTemplateCorePageType, string>,
  ): Promise<void> {
    const configuration = await this.websiteConfigurationRepository.findByAcademyId(tx, academyId);
    if (!configuration) return;

    const footer = configuration.footer as { groups: unknown[]; socialLinks: unknown[]; copyrightText?: unknown };
    const footerUntouched = (footer.groups?.length ?? 0) === 0 && !footer.copyrightText;
    if (footerUntouched) {
      const navPages: readonly WebsiteTemplateCorePageType[] = ['about', 'courses', 'faqs', 'contact'];
      const links = navPages
        .filter((coreType) => pageIdByCoreType.has(coreType))
        .map((coreType) => ({
          id: randomUUID(),
          label: { en: CORE_PAGE_DEFAULTS[coreType].title, ar: '' },
          pageId: pageIdByCoreType.get(coreType)!,
        }));

      await this.websiteConfigurationRepository.update(tx, academyId, {
        footer: {
          groups:
            links.length > 0
              ? [{ id: randomUUID(), title: lt('Quick Links', 'روابط سريعة'), links }]
              : [],
          socialLinks: footer.socialLinks ?? [],
          copyrightText: lt(
            interpolate('© ' + new Date().getFullYear() + ' {{academyName}}', context),
            interpolate('© ' + new Date().getFullYear() + ' {{academyName}}', context),
          ),
        } as unknown as Prisma.InputJsonValue,
      });
    }

    const header = configuration.header as { cta?: unknown; authPages?: unknown };
    if (!header.cta) {
      await this.websiteConfigurationRepository.update(tx, academyId, {
        header: {
          cta: { label: lt('Sign Up', 'إنشاء حساب'), authAction: 'signUp' },
          authPages: header.authPages,
        } as unknown as Prisma.InputJsonValue,
      });
    }
  }
}
