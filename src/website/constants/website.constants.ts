/**
 * Website validation constants — a field-for-field backend reproduction of
 * the real frontend's `atlas-front/src/features/website/constants/
 * website.constants.ts` (Prompt 9's own values only; the file's own
 * "CMS content (Prompt 10)"/"SEO (Prompt 10)" sections are read too, since
 * `WebsiteSeoConfig`/`WebsitePageSeo` are Prompt 9 types even though some
 * of their bound constants live in that later-numbered file section —
 * confirmed by direct inspection of `website.types.ts`, which is entirely
 * Prompt 9). Never redeclared with different values — a drift here would
 * silently diverge from what the frontend's own Zod resolvers already
 * enforce client-side.
 */

export const MAX_PAGE_TITLE_LENGTH = 100;
export const MAX_PAGE_SLUG_LENGTH = 60;
export const MIN_PAGE_SLUG_LENGTH = 2;

/** Same shape as the frontend's `PAGE_SLUG_REGEX`. */
export const PAGE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reserved slugs a custom page must not claim — the core pages already own these. */
export const RESERVED_PAGE_SLUGS: readonly string[] = [
  'home',
  'about',
  'courses',
  'faqs',
  'contact',
  // Phase 1 (Extended Scope, Decision 11, dependency C) — real public
  // routes (`PublicWebsiteRouter`), not CMS content; a Custom Page must
  // never claim either slug.
  'sign-in',
  'sign-up',
];

export const MAX_SEO_TITLE_LENGTH = 70;
export const MAX_SEO_DESCRIPTION_LENGTH = 160;

/** A validated HSL triplet, e.g. `"221 83% 53%"`. */
export const HSL_TRIPLET_REGEX = /^\d{1,3} \d{1,3}% \d{1,3}%$/;

/** The bounded icon names a Feature item may reference — a curated subset of `lucide-react`, never an arbitrary asset. */
export const FEATURE_ICON_OPTIONS: readonly string[] = [
  'GraduationCap',
  'BookOpen',
  'Award',
  'Users',
  'Clock',
  'ShieldCheck',
  'Sparkles',
  'Globe',
  'Video',
  'Headphones',
];

export const MAX_SECTION_ITEMS = 12;

export const MAX_SITE_TITLE_LENGTH = 70;
export const MAX_OG_TITLE_LENGTH = 70;
export const MAX_OG_DESCRIPTION_LENGTH = 200;

/** A site-relative path only — never a full origin/protocol. */
export const CANONICAL_PATH_REGEX = /^\/[a-z0-9/-]*$/;
export const MAX_CANONICAL_PATH_LENGTH = 200;

export const MAX_SHORT_TEXT = 100;
export const MAX_LONG_TEXT = 2000;

/** Schemes a tenant-authored link is allowed to use — matches `isSafeExternalUrl`'s `ALLOWED_URL_SCHEMES` exactly. */
export const ALLOWED_URL_SCHEMES: readonly string[] = [
  'http:',
  'https:',
  'mailto:',
  'tel:',
];

/** Matches `WEBSITE_CORE_PAGE_TYPES` (`website.types.ts`) exactly. */
export const WEBSITE_CORE_PAGE_TYPES = [
  'home',
  'about',
  'courses',
  'faqs',
  'contact',
  'courseDetails',
] as const;

/** Matches `TOGGLEABLE_CORE_PAGE_TYPES` — every core page except `courseDetails` (no visibility toggle in the real UI, `WebsitePagesPage.tsx`). */
export const TOGGLEABLE_CORE_PAGE_TYPES: readonly string[] = [
  'home',
  'about',
  'courses',
  'faqs',
  'contact',
];

/** Matches `SECTION_TYPES` (`website-section.types.ts`) exactly, in the same order. */
export const SECTION_TYPES = [
  'hero',
  'about',
  'featuredCourses',
  // P64 Phase 4 §E.1 — the filterable, server-paginated public catalog.
  'courseCatalog',
  'statistics',
  'features',
  'testimonials',
  'faq',
  'cta',
  'instructors',
  'gallery',
  'contact',
  // Theme 1 plan §D.2 — shared by every theme, each with a base renderer.
  'pageHeader',
  'courseCategories',
  'steps',
  'featureSplit',
] as const;

/** Theme 1 plan §B density: one idea per section, 3–6 items. */
export const MAX_SECTION_STEPS = 6;
export const MAX_FEATURE_SPLIT_ITEMS = 6;
export const MAX_HERO_HIGHLIGHTS = 4;
export const MAX_CHIP_TEXT = 40;
export const MIN_COURSE_CATEGORIES = 2;

/**
 * What an image field may hold (Theme 1 plan §E.4): a theme asset
 * reference (`theme-asset:<theme>/<key>`), an Atlas MediaAsset URL (the
 * RELATIVE `/api/v1/public/media/<storageKey>` that `toMediaAssetUrl`
 * returns — what the media library and direct uploads store), an absolute
 * http(s) URL (http only matters for local/CI object stores), a LEGACY
 * inline upload (`data:image/...;base64,` — the only types uploads ever
 * accepted), or empty. Anything else — `javascript:`, `data:text/html`,
 * `blob:`, any other relative path — is rejected.
 */
export const THEME_ASSET_REFERENCE_PATTERN = /^theme-asset:[a-z0-9-]+\/[a-z0-9-]+$/;
/** No `.` before the extension, so no `..` segment can appear. */
export const MEDIA_ASSET_PATH_PATTERN =
  /^\/api\/v1\/public\/media\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.[a-z0-9]+$/;
export const LEGACY_DATA_IMAGE_PATTERN =
  /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** `courseCatalog` page-size bounds — match the frontend `website.constants.ts` exactly. */
export const MIN_COURSE_CATALOG_PAGE_SIZE = 6;
export const MAX_COURSE_CATALOG_PAGE_SIZE = 48;
/** Matches the frontend `COURSE_CATALOG_SORT_VALUES` exactly. */
export const COURSE_CATALOG_SORT_VALUES = [
  'newest',
  'title',
  'priceAsc',
  'priceDesc',
] as const;

/**
 * The themes an Owner (or a provisioning request) may select. Matches
 * `SELECTABLE_WEBSITE_THEME_KEYS` (`website-theme.types.ts`) exactly. A
 * future theme is appended here (index 0 stays the platform default) and
 * registered in both template/theme registries.
 */
export const SELECTABLE_WEBSITE_THEME_KEYS = [
  'modern-education',
  // Theme 2 — Atelier (frontend repo, Reports/THEME_2_ATELIER_PLAN.md).
  'atelier',
] as const;

/**
 * W2 — the platform's default theme: what `WebsiteBootstrapService` gives a
 * new website configuration, and what provisioning applies (and generates
 * starter pages for) when a request names no theme.
 */
export const DEFAULT_WEBSITE_THEME_KEY: (typeof SELECTABLE_WEBSITE_THEME_KEYS)[number] =
  SELECTABLE_WEBSITE_THEME_KEYS[0];

/**
 * The original Themes 2–5, retired from selection (frontend repo,
 * Reports/THEMES_2_5_RETIREMENT.md) — not the current Theme 2, Atelier.
 * Their code stays until every website on them has been moved to
 * `RETIRED_WEBSITE_THEME_REPLACEMENT` (`npm run db:retire-website-themes`)
 * and verified, so a website still on one keeps rendering as it does.
 */
export const RETIRED_WEBSITE_THEME_KEYS = [
  'premium-academy',
  'corporate-learning',
  'minimal-editorial',
  'bold-creative',
] as const;

/** What a retired theme is replaced with, by the migration and by provisioning. */
export const RETIRED_WEBSITE_THEME_REPLACEMENT = 'modern-education' as const;

/** Every theme key the code knows (selectable or retired). Matches `WEBSITE_THEME_KEYS` (`website-theme.types.ts`) exactly — a client-side, code-registered catalog; the backend only records which key was picked, never validates against a server-side theme table (master plan §21 P9: "only implement what the frontend already defines"). */
export const WEBSITE_THEME_KEYS = [
  ...SELECTABLE_WEBSITE_THEME_KEYS,
  ...RETIRED_WEBSITE_THEME_KEYS,
] as const;

/** A retired key's replacement; any other key unchanged. */
export function selectableWebsiteThemeKey(
  key: (typeof WEBSITE_THEME_KEYS)[number],
): (typeof SELECTABLE_WEBSITE_THEME_KEYS)[number] {
  return (RETIRED_WEBSITE_THEME_KEYS as readonly string[]).includes(key)
    ? RETIRED_WEBSITE_THEME_REPLACEMENT
    : (key as (typeof SELECTABLE_WEBSITE_THEME_KEYS)[number]);
}

/** Sensible, schema-conformant bootstrap default — overwritten the first time an Academy Owner actually configures their brand colors. Not derived from any theme's real `defaultPrimary`/`defaultSecondary`/`defaultAccent` token (that registry is frontend-only, code-level, never exposed to the backend by any real contract). */
export const DEFAULT_BRAND_COLOR = '221 83% 53%';

/**
 * Phase 6 (Bilingual Academy Websites) — how a newly provisioned Academy's
 * website starts. `'empty'` is the safe default for any caller that
 * doesn't set this explicitly (see `CreateProvisioningRequestDto`'s own
 * doc comment) — real, structured, theme-appropriate pages/sections exist
 * either way (`WebsiteGenerationService`); `'complete'` additionally fills
 * every section with real, bilingual starter content.
 */
export const WEBSITE_SETUP_MODES = ['empty', 'complete'] as const;

/* -------------------------------------------------------------------- */
/* CMS content (Prompt 10) — matches the real frontend's                */
/* `website.constants.ts` "CMS content" section values exactly.         */
/* -------------------------------------------------------------------- */

export const MAX_FAQ_QUESTION_LENGTH = 200;
export const MAX_FAQ_ANSWER_LENGTH = 2000;
export const MAX_TESTIMONIAL_QUOTE_LENGTH = 500;
export const MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH = 100;
export const MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH = 100;

/** Matches `WebsiteContentStatus` (`website-content.types.ts`) exactly. */
export const WEBSITE_CONTENT_STATUS_VALUES = ['draft', 'published', 'archived'] as const;
