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
  'statistics',
  'features',
  'testimonials',
  'faq',
  'cta',
  'instructors',
  'gallery',
  'contact',
] as const;

/** Matches `WEBSITE_THEME_KEYS` (`website-theme.types.ts`) exactly — a client-side, code-registered catalog; the backend only records which key was picked, never validates against a server-side theme table (master plan §21 P9: "only implement what the frontend already defines"). */
export const WEBSITE_THEME_KEYS = [
  'modern-education',
  'premium-academy',
  'corporate-learning',
  'minimal-editorial',
  'bold-creative',
] as const;

/** Sensible, schema-conformant bootstrap default — overwritten the first time an Academy Owner actually configures their brand colors. Not derived from any theme's real `defaultPrimary`/`defaultSecondary`/`defaultAccent` token (that registry is frontend-only, code-level, never exposed to the backend by any real contract). */
export const DEFAULT_BRAND_COLOR = '221 83% 53%';

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
