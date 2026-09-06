/**
 * Website Template — Phase 6 (Bilingual Academy Websites).
 *
 * A SECOND, PARALLEL concept to `WebsiteThemeDefinition` — deliberately
 * not merged into it. `WebsiteThemeDefinition` (frontend-only,
 * `website-theme.types.ts`) is explicitly documented as "a TOKEN + VARIANT
 * set, not executable code or markup" — bolting page/section CONTENT onto
 * it would blur that boundary and turn every small, independent theme
 * file into a large, bilingual-content-carrying one. A theme answers
 * "what does it look like"; a template answers "what does it contain."
 * They share a key (`WEBSITE_THEME_KEYS`, this backend's own copy of it —
 * see `website.constants.ts`'s own doc comment on why the backend keeps
 * its own mirrored catalog) so picking a look and getting its matching
 * starter content is one action for the client, while remaining two
 * independently maintainable registries for the codebase — exactly the
 * "one file per key, a registry aggregates them, adding one never touches
 * another" pattern `WebsiteThemeRegistry` already proves works.
 *
 * This lives on the BACKEND (unlike `WebsiteThemeDefinition`) because
 * `WebsiteGenerationService` is what writes real `WebsitePage` rows, and
 * that only ever happens server-side (the theme "look" has no such
 * writer — the client just picks a key).
 */
import type { SECTION_TYPES, WEBSITE_CORE_PAGE_TYPES, WEBSITE_THEME_KEYS } from '../constants/website.constants';

export type WebsiteTemplateThemeKey = (typeof WEBSITE_THEME_KEYS)[number];
export type WebsiteTemplateCorePageType = (typeof WEBSITE_CORE_PAGE_TYPES)[number];
export type SectionType = (typeof SECTION_TYPES)[number];

export interface WebsiteTemplateSection {
  readonly type: SectionType;
  /**
   * Fields resolved LIVE from real Academy data at render time — never
   * authored copy, never a snapshot taken at generation time (see
   * `WebsiteGenerationService`'s own doc comment, "a configuration, not a
   * lookup"). Only meaningful for the section types that already support
   * live data (`featuredCourses`, `statistics`, `instructors`, `contact`
   * — see `section-config.schemas.ts`).
   */
  readonly dynamicDefaults?: Record<string, unknown>;
  /**
   * Present only for "Complete Website" generation — every visitor-facing
   * copy value here is `{ en, ar }` (`LocalizedText`), matching exactly
   * which fields `section-config.schemas.ts` widened for this
   * `type`. Skipped entirely for "Empty Academy" generation, which is
   * what naturally produces "same structure, minimal content" without a
   * second code path (`WebsiteGenerationService`).
   */
  readonly starterContent?: Record<string, unknown>;
  /**
   * A template is authored before any real `WebsitePage` id exists, so a
   * CTA can't carry a real `pageId` directly — this declares INTENT
   * instead ("this section's primary CTA should point at the Courses
   * page," or at the fixed, non-`WebsitePage` Sign In/Sign Up surfaces —
   * see `WebsiteCta.authAction`), and `WebsiteGenerationService` resolves
   * a core-page-type target to the real id of the page it just created,
   * in the same generation pass. Keys match `WebsiteCtaSchema`'s own
   * `cta`/`secondaryCta` field names; never used for a section type with
   * no CTA field.
   */
  readonly ctaTargets?: Partial<
    Record<'cta' | 'secondaryCta', WebsiteTemplateCorePageType | 'signIn' | 'signUp'>
  >;
}

export interface WebsiteTemplatePage {
  readonly coreType: WebsiteTemplateCorePageType;
  readonly sections: readonly WebsiteTemplateSection[];
}

export interface WebsiteTemplateDefinition {
  readonly themeKey: WebsiteTemplateThemeKey;
  readonly pages: readonly WebsiteTemplatePage[];
}
