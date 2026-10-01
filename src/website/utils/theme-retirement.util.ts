/**
 * Themes 2–5 retirement (frontend repo, Reports/THEMES_2_5_RETIREMENT.md) — the pure part
 * of `scripts/retire-website-themes.ts`: which websites move, what each
 * one holds, and a fingerprint of everything the move must leave alone.
 *
 * The move changes `website_configurations.theme_key` only (plus
 * `config_version`, which keys the public cache). Pages, sections, brand
 * colours, palette, logos, navigation, header, footer, SEO and the
 * template provenance (`template_key`/`template_version`) are untouched;
 * the fingerprint proves it before and after.
 *
 * Every section type is mappable: Theme 1's pack draws all of
 * `SECTION_TYPES` itself (frontend `theme-pack.test.tsx`). A section is
 * reported as unmappable only when its data can't render on any theme —
 * an unknown type, or a malformed `sections` column — so an operator sees
 * it before anything is written.
 */
import { createHash } from 'node:crypto';
import {
  RETIRED_WEBSITE_THEME_KEYS,
  RETIRED_WEBSITE_THEME_REPLACEMENT,
  SECTION_TYPES,
  SELECTABLE_WEBSITE_THEME_KEYS,
} from '../constants/website.constants';

export interface ThemeRetirementPage {
  readonly id: string;
  readonly slug: string;
  readonly pageType: string;
  readonly coreType: string | null;
  readonly visible: boolean;
  readonly seo: unknown;
  readonly sections: unknown;
  readonly version: number;
}

export interface ThemeRetirementWebsite {
  readonly academyId: string;
  readonly organizationId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly themeKey: string;
  readonly themeVersion: number;
  readonly configVersion: number;
  readonly templateKey: string | null;
  readonly templateVersion: number | null;
  readonly status: string;
  readonly brand: unknown;
  readonly seo: unknown;
  readonly navigation: unknown;
  readonly header: unknown;
  readonly footer: unknown;
  readonly pages: readonly ThemeRetirementPage[];
}

export interface UnmappableSection {
  readonly pageSlug: string;
  readonly sectionId: string | null;
  readonly type: string | null;
  readonly reason: 'unknownSectionType' | 'malformedSections';
}

/**
 * A section Theme 1 does not draw on the public site until it has content
 * (plan §D.4): testimonials without a real, non-sample quote, a gallery
 * without images. Themes 2–5 drew its heading over nothing. Nothing is
 * lost — the section stays stored and appears once it has content — but
 * the Owner sees it before the move. (Statistics and instructors follow
 * the same rule on live data, which a dry run can't know.)
 */
export interface HiddenUntilContentSection {
  readonly pageSlug: string;
  readonly sectionId: string | null;
  readonly type: 'testimonials' | 'gallery';
}

export interface ThemeRetirementPlanEntry {
  readonly academyId: string;
  readonly organizationId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly fromThemeKey: string;
  readonly toThemeKey: typeof RETIRED_WEBSITE_THEME_REPLACEMENT;
  /** `retired`: one of Themes 2–5. `unknown`: a key no code knows (already renders as Theme 1). */
  readonly classification: 'retired' | 'unknown';
  readonly status: string;
  readonly configVersion: number;
  readonly templateKey: string | null;
  readonly templateVersion: number | null;
  readonly pages: number;
  readonly visiblePages: number;
  readonly sectionsByType: Readonly<Record<string, number>>;
  readonly unmappableSections: readonly UnmappableSection[];
  readonly hiddenUntilContent: readonly HiddenUntilContentSection[];
  readonly brand: {
    readonly primaryColor: string | null;
    readonly secondaryColor: string | null;
    readonly accentColor: string | null;
    readonly hasPalette: boolean;
    readonly hasDarkLogo: boolean;
  };
  /** sha256 of everything the move must not change; identical before and after. */
  readonly fingerprint: string;
}

const SELECTABLE = SELECTABLE_WEBSITE_THEME_KEYS as readonly string[];
const RETIRED = RETIRED_WEBSITE_THEME_KEYS as readonly string[];
const KNOWN_SECTION_TYPES = SECTION_TYPES as readonly string[];

/** JSON with object keys sorted, so the fingerprint doesn't depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Everything but the theme key and the cache version. */
export function websiteContentFingerprint(website: ThemeRetirementWebsite): string {
  const pages = [...website.pages]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((page) => ({
      id: page.id,
      slug: page.slug,
      pageType: page.pageType,
      coreType: page.coreType,
      visible: page.visible,
      seo: page.seo,
      sections: page.sections,
      version: page.version,
    }));
  const content = {
    themeVersion: website.themeVersion,
    templateKey: website.templateKey,
    templateVersion: website.templateVersion,
    status: website.status,
    brand: website.brand,
    seo: website.seo,
    navigation: website.navigation,
    header: website.header,
    footer: website.footer,
    pages,
  };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

function hasText(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(
    (text) => typeof text === 'string' && text.trim().length > 0,
  );
}

function isEmptyForTheme1(type: 'testimonials' | 'gallery', config: unknown): boolean {
  const record = (config ?? {}) as { items?: unknown; images?: unknown };
  if (type === 'gallery')
    return !Array.isArray(record.images) || record.images.length === 0;
  const items = Array.isArray(record.items) ? record.items : [];
  return !items.some((item) => {
    const quote = item as { quote?: unknown; sample?: unknown };
    return quote.sample !== true && hasText(quote.quote);
  });
}

/** Null when the website is already on a selectable theme (nothing to do). */
export function planThemeRetirement(
  website: ThemeRetirementWebsite,
): ThemeRetirementPlanEntry | null {
  if (SELECTABLE.includes(website.themeKey)) return null;

  const sectionsByType: Record<string, number> = {};
  const unmappableSections: UnmappableSection[] = [];
  const hiddenUntilContent: HiddenUntilContentSection[] = [];
  for (const page of website.pages) {
    if (!Array.isArray(page.sections)) {
      unmappableSections.push({
        pageSlug: page.slug,
        sectionId: null,
        type: null,
        reason: 'malformedSections',
      });
      continue;
    }
    for (const section of page.sections as unknown[]) {
      const record = (section ?? {}) as {
        id?: unknown;
        type?: unknown;
        config?: unknown;
      };
      const type = typeof record.type === 'string' ? record.type : null;
      const id = typeof record.id === 'string' ? record.id : null;
      if (type) sectionsByType[type] = (sectionsByType[type] ?? 0) + 1;
      if (!type || !KNOWN_SECTION_TYPES.includes(type)) {
        unmappableSections.push({
          pageSlug: page.slug,
          sectionId: id,
          type,
          reason: 'unknownSectionType',
        });
      }
      if (
        (type === 'testimonials' || type === 'gallery') &&
        isEmptyForTheme1(type, record.config)
      ) {
        hiddenUntilContent.push({ pageSlug: page.slug, sectionId: id, type });
      }
    }
  }

  const brand = (website.brand ?? {}) as Record<string, unknown>;
  const colour = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  return {
    academyId: website.academyId,
    organizationId: website.organizationId,
    academyName: website.academyName,
    academySlug: website.academySlug,
    fromThemeKey: website.themeKey,
    toThemeKey: RETIRED_WEBSITE_THEME_REPLACEMENT,
    classification: RETIRED.includes(website.themeKey) ? 'retired' : 'unknown',
    status: website.status,
    configVersion: website.configVersion,
    templateKey: website.templateKey,
    templateVersion: website.templateVersion,
    pages: website.pages.length,
    visiblePages: website.pages.filter((page) => page.visible).length,
    sectionsByType,
    unmappableSections,
    hiddenUntilContent,
    brand: {
      primaryColor: colour(brand.primaryColor),
      secondaryColor: colour(brand.secondaryColor),
      accentColor: colour(brand.accentColor),
      hasPalette: brand.palette !== undefined && brand.palette !== null,
      hasDarkLogo: typeof brand.darkLogo === 'string' && brand.darkLogo.length > 0,
    },
    fingerprint: websiteContentFingerprint(website),
  };
}

/** Whole-run totals for the report header. */
export function summariseThemeRetirement(
  scanned: number,
  entries: readonly ThemeRetirementPlanEntry[],
): {
  readonly scanned: number;
  readonly toMove: number;
  readonly byTheme: Readonly<Record<string, number>>;
  readonly published: number;
  readonly withUnmappableSections: number;
  readonly withSectionsHiddenUntilContent: number;
  readonly withoutStoredColours: number;
} {
  const byTheme: Record<string, number> = {};
  for (const entry of entries) {
    byTheme[entry.fromThemeKey] = (byTheme[entry.fromThemeKey] ?? 0) + 1;
  }
  return {
    scanned,
    toMove: entries.length,
    byTheme,
    published: entries.filter((entry) => entry.status === 'published').length,
    withUnmappableSections: entries.filter((entry) => entry.unmappableSections.length > 0)
      .length,
    withSectionsHiddenUntilContent: entries.filter(
      (entry) => entry.hiddenUntilContent.length > 0,
    ).length,
    // A website with no stored colours takes its theme's defaults, so its
    // colours WOULD change on the move; the schema requires them, so this
    // is expected to be 0 and is reported rather than assumed.
    withoutStoredColours: entries.filter(
      (entry) =>
        !entry.brand.primaryColor ||
        !entry.brand.secondaryColor ||
        !entry.brand.accentColor,
    ).length,
  };
}
