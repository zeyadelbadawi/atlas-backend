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
  // B0-WEB-02 — the language prefixes (`/ar/...`, and `/en/...` on an
  // Arabic-default site): a page at either slug would be shadowed.
  'ar',
  'en',
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

/**
 * Section content limits — characters per language (`en` and `ar` each).
 * Identical to the frontend's `website.constants.ts`; the shared parity
 * cases (`validation/__parity__`) prove both schemas agree at every
 * boundary.
 *
 * They live on the shared section contract, not per theme: a section's
 * config survives a theme switch (`PATCH themeKey` changes only the theme),
 * so a value valid in one theme must be valid in every theme.
 *
 * | Field                                  | Limit |
 * | -------------------------------------- | ----- |
 * | hero eyebrow                           | 60    |
 * | hero title / emphasised highlight      | 70    |
 * | hero subtitle                          | 140   |
 * | hero description                       | 280   |
 * | hero highlight chip label              | 40    |
 * | every section CTA label                | 40    |
 * | steps title                            | 80    |
 * | steps description                      | 240   |
 * | step title                             | 60    |
 * | step description                       | 240   |
 * | statistics title                       | 80    |
 * | statistic label                        | 40    |
 * | other short text (titles, alt text)    | 100   |
 * | other long text (descriptions, bodies) | 2000  |
 *
 * Counted as zod counts (`string.length`, UTF-16 code units — every Arabic
 * diacritic is a character). Enforced on every page write
 * (`WebsitePagesService.update`, `WebsiteGenerationService`); reads never
 * re-validate, so content stored under an older, looser limit keeps
 * rendering and is only refused when a page holding it is next saved.
 * The header CTA and navigation/footer labels are site settings
 * (`website-config.schemas.ts`), not section content, and keep
 * `MAX_SHORT_TEXT`.
 */
export const MAX_HERO_EYEBROW_LENGTH = 60;
export const MAX_HERO_TITLE_LENGTH = 70;
export const MAX_HERO_SUBTITLE_LENGTH = 140;
export const MAX_HERO_DESCRIPTION_LENGTH = 280;
export const MAX_CTA_LABEL_LENGTH = 40;
/** The text a WhatsApp button pre-fills in the visitor's chat. */
export const MAX_CTA_WHATSAPP_MESSAGE_LENGTH = 300;
/**
 * The looks an Owner can give a section button. Absent means the theme's
 * own look for that position (first button bold, second quieter, third a
 * text link) — what every button saved before this choice existed shows.
 */
export const CTA_STYLES = ['primary', 'secondary', 'link'] as const;
/** A WhatsApp number, international (E.164): `+`, country code, number — 8 to 15 digits. */
export const CTA_WHATSAPP_NUMBER_PATTERN = /^\+[1-9]\d{7,14}$/;
/** A number to call: international (E.164) or a short hotline (3–6 digits, e.g. 19999). */
export const CTA_PHONE_NUMBER_PATTERN = /^(?:\+[1-9]\d{7,14}|\d{3,6})$/;

/*
 * CMS phase 3 — a section's design ("Design" in the visual editor): named
 * choices, never colours or numbers. Each theme draws them with its own,
 * contrast-checked grounds and rhythm, so a brand colour change still
 * restyles every section. Absent = the theme's own choice for that section.
 */
/** The ground a section sits on: the theme's lightest, its soft band, its brand band, its dark band. */
export const SECTION_BACKGROUNDS = ['light', 'soft', 'brand', 'dark'] as const;
/** The space above and below a section, relative to the theme's rhythm. */
export const SECTION_SPACINGS = ['compact', 'default', 'spacious'] as const;
export const SECTION_ALIGNMENTS = ['start', 'center'] as const;
export const SECTION_WIDTHS = ['default', 'wide'] as const;
export const MAX_STEPS_TITLE_LENGTH = 80;
export const MAX_STEPS_DESCRIPTION_LENGTH = 240;
export const MAX_STEP_TITLE_LENGTH = 60;
export const MAX_STEP_DESCRIPTION_LENGTH = 240;
export const MAX_STATISTICS_TITLE_LENGTH = 80;
export const MAX_STATISTIC_LABEL_LENGTH = 40;
/** A statistic's authored value ("500+", "٥٠٠+"). */
export const MAX_STATISTIC_VALUE_LENGTH = 20;

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
  // Theme 4 plan §6 (frontend repo, Reports/THEME_4_RIWAQ_PLAN.md) — one real
  // course's outcomes and syllabus; shared by every theme with a base renderer.
  'courseSpotlight',
  // CMS phase 3d (batch B) — shared by every theme, each with a renderer:
  // partner/accreditation logos, where the academy is, the class timetable
  // and student results.
  'logos',
  'map',
  'schedule',
  'results',
  // CMS phase 3d (batch A) — shared by every theme, each with a base renderer.
  'whatsappBar',
  'video',
  'pricing',
  'countdown',
  // CMS phase 3d (batch D) — shared by every theme, each with a renderer: a
  // learning path, student/parent video reviews, downloadable resources and
  // certificates/accreditations.
  'timeline',
  'videoTestimonials',
  'downloads',
  'certificates',
  // CMS phase 3d (batch C) — shared by every theme, each with a renderer:
  // the "register your interest" form (it reaches the academy's Messages
  // like the contact form), a slim notice strip and a comparison table.
  'interestForm',
  'announcementBar',
  'comparison',
  // CMS phase 3c — the flexible section an Owner builds from elements, in
  // one, two or three columns (`custom-section` limits below).
  'custom',
] as const;

/**
 * CMS phase 3d (batch B) limits — match the frontend `website.constants.ts`
 * exactly (the parity cases prove both schemas agree at each boundary).
 *
 * | Field                          | Limit |
 * | ------------------------------ | ----- |
 * | logos per section              | 12    |
 * | map address (multi-line)       | 300   |
 * | map note                       | 140   |
 * | map query (address or lat,lng) | 200   |
 * | schedule rows                  | 30    |
 * | schedule row title             | 80    |
 * | schedule teacher / location    | 60    |
 * | results per section            | 24    |
 * | a result ("98%", "الأول …")    | 40    |
 */
export const MAX_LOGOS = 12;
export const MAX_MAP_ADDRESS_LENGTH = 300;
export const MAX_MAP_NOTE_LENGTH = 140;
export const MAX_MAP_QUERY_LENGTH = 200;
export const MAX_SCHEDULE_ROWS = 30;
export const MAX_SCHEDULE_ROW_TITLE_LENGTH = 80;
export const MAX_SCHEDULE_ROW_DETAIL_LENGTH = 60;
export const MAX_RESULTS = 24;
export const MAX_RESULT_VALUE_LENGTH = 40;
/** The days a schedule row may fall on, in the order an Egyptian week runs (Saturday first). */
export const SCHEDULE_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
/** A 24-hour clock time, `HH:MM` (what `<input type="time">` gives). */
export const SCHEDULE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/*
 * CMS phase 3d (batch A) — the "Talk to us" bar, the click-to-play video,
 * pricing plans and the registration countdown. Characters per language,
 * like every limit above; mirrored exactly by the frontend's
 * `website.constants.ts` and proven at the boundaries by the parity cases.
 */
export const MAX_WHATSAPP_BAR_TITLE_LENGTH = 80;
export const MAX_WHATSAPP_BAR_DESCRIPTION_LENGTH = 200;
export const MAX_VIDEO_DESCRIPTION_LENGTH = 280;
export const MAX_VIDEO_CAPTION_LENGTH = 200;
/** A YouTube video id: exactly 11 characters of YouTube's own alphabet. */
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const MIN_PRICING_PLANS = 1;
export const MAX_PRICING_PLANS = 4;
export const MAX_PRICING_FEATURES = 10;
export const MAX_PRICING_DESCRIPTION_LENGTH = 280;
export const MAX_PRICING_PLAN_NAME_LENGTH = 40;
/** Free text, e.g. "450 ج.م" or "Free". */
export const MAX_PRICING_PRICE_LENGTH = 24;
export const MAX_PRICING_PERIOD_LENGTH = 30;
export const MAX_PRICING_PLAN_DESCRIPTION_LENGTH = 160;
export const MAX_PRICING_FEATURE_LENGTH = 80;
export const MAX_PRICING_BADGE_LENGTH = 24;
export const MAX_COUNTDOWN_TITLE_LENGTH = 80;
export const MAX_COUNTDOWN_DESCRIPTION_LENGTH = 240;
export const MAX_COUNTDOWN_ENDED_MESSAGE_LENGTH = 160;
/** An ISO 8601 date and time WITH its offset (`2026-11-05T23:59:00+02:00`). */
export const COUNTDOWN_DEADLINE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;
/** An IANA time zone name (`Africa/Cairo`, `UTC`) — the academy's, for showing the deadline. */
export const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
export const MAX_TIME_ZONE_LENGTH = 64;

/*
 * CMS phase 3d (batch C) — the "register your interest" form, the notice
 * strip and the comparison table. Characters per language, like every limit
 * above; mirrored exactly by the frontend's `website.constants.ts` and
 * proven at the boundaries by the parity cases.
 */
export const MAX_INTEREST_FORM_DESCRIPTION_LENGTH = 280;
/** The choice list's own label ("Course", "Grade"). */
export const MAX_INTEREST_CHOICE_LABEL_LENGTH = 60;
export const MAX_INTEREST_OPTIONS = 12;
export const MAX_INTEREST_OPTION_LENGTH = 80;
export const MAX_INTEREST_SUCCESS_MESSAGE_LENGTH = 200;
/**
 * How the form shows one of its optional fields (email, the choice list, a
 * message): not at all, as optional, or as required. Name and phone are
 * always shown and required.
 */
export const INTEREST_FIELD_MODES = ['hidden', 'optional', 'required'] as const;
export const MAX_ANNOUNCEMENT_TEXT_LENGTH = 140;
/**
 * The notice strip's ground, drawn by each theme from its own palette —
 * named, never a colour: the brand's own fill, the theme's soft ground or
 * its dark ground. Every one keeps the text and the button at 4.5:1.
 */
export const ANNOUNCEMENT_TONES = ['brand', 'soft', 'dark'] as const;
export const MAX_COMPARISON_DESCRIPTION_LENGTH = 280;
export const MIN_COMPARISON_COLUMNS = 2;
export const MAX_COMPARISON_COLUMNS = 4;
export const MAX_COMPARISON_ROWS = 15;
export const MAX_COMPARISON_COLUMN_LABEL_LENGTH = 40;
export const MAX_COMPARISON_ROW_LABEL_LENGTH = 80;
/** A short text cell ("Twice a week", "مرتين أسبوعيًا"). */
export const MAX_COMPARISON_CELL_TEXT_LENGTH = 40;
/** A cell: ✓ (`yes`), ✗ (`no`) or a short text in both languages. */
export const COMPARISON_CELL_VALUES = ['yes', 'no', 'text'] as const;

/*
 * CMS phase 3d (batch D) — the learning path, video reviews, downloads and
 * certificates. Characters per language, like every limit above; mirrored
 * exactly by the frontend's `website.constants.ts` and proven at the
 * boundaries by the parity cases.
 */
export const MAX_TIMELINE_MILESTONES = 12;
export const MAX_TIMELINE_MILESTONE_TITLE_LENGTH = 80;
/** "Sept–Oct", "Term 1". */
export const MAX_TIMELINE_PERIOD_LENGTH = 40;
export const MAX_TIMELINE_MILESTONE_DESCRIPTION_LENGTH = 240;
export const MAX_VIDEO_TESTIMONIALS = 9;
/** "Parent of a Grade 12 student". */
export const MAX_VIDEO_TESTIMONIAL_ROLE_LENGTH = 80;
/** A short pull quote under the video. */
export const MAX_VIDEO_TESTIMONIAL_QUOTE_LENGTH = 200;
export const MAX_DOWNLOADS = 20;
export const MAX_DOWNLOAD_TITLE_LENGTH = 100;
export const MAX_DOWNLOAD_DESCRIPTION_LENGTH = 200;
export const MAX_DOWNLOAD_URL_LENGTH = 2048;
/** "PDF", "DOCX". */
export const MAX_DOWNLOAD_FILE_TYPE_LENGTH = 12;
/** "2.4 MB". */
export const MAX_DOWNLOAD_FILE_SIZE_LENGTH = 16;
export const MAX_CERTIFICATES = 12;
/** A four-digit year from 1900 to 2099 ("2025"). */
export const CERTIFICATE_YEAR_PATTERN = /^(?:19|20)\d{2}$/;

/*
 * CMS phase 3c — the custom section: an Owner's own layout of one, two or
 * three columns, each an ordered list of elements (a heading, text, buttons,
 * an image, a video, a checklist, a spacer, a divider, an icon with text).
 * Named choices only — no pixels, no positions — and every limit below is
 * mirrored exactly by the frontend's `website.constants.ts` and proven at
 * its boundary by the parity cases.
 *
 * | Limit                         | Value | Why                                                       |
 * | ----------------------------- | ----- | --------------------------------------------------------- |
 * | columns                       | 1–3   | the named layouts; more would not read on a laptop        |
 * | elements per column           | 12    | one idea per section; 36 at most keeps a page's JSON small |
 * | heading                       | 120   | a headline, not a paragraph                               |
 * | text (multi-line, plain)      | 1500  | a few short paragraphs; longer copy belongs on its page   |
 * | checklist items               | 1–10  | a scannable list                                          |
 * | checklist item                | 120   | one line on a phone, two at most                          |
 * | icon + text: title / text     | 80/240| the features' card proportions                            |
 * | video title                   | 100   | names the play button and the player                      |
 */
/** How many columns each layout has. */
export const CUSTOM_SECTION_LAYOUT_COLUMNS = { one: 1, two: 2, three: 3 } as const;
export const CUSTOM_SECTION_LAYOUTS = ['one', 'two', 'three'] as const;
/** Two columns only: equal halves, or one about twice the other. */
export const CUSTOM_SECTION_RATIOS = ['equal', 'wideNarrow', 'narrowWide'] as const;
/** Where shorter columns sit beside a taller one. */
export const CUSTOM_SECTION_VERTICAL_ALIGNS = ['top', 'center'] as const;
export const CUSTOM_ELEMENT_KINDS = [
  'heading',
  'text',
  'button',
  'image',
  'video',
  'checklist',
  'spacer',
  'divider',
  'iconText',
] as const;
export const CUSTOM_HEADING_LEVELS = ['h2', 'h3'] as const;
export const CUSTOM_SPACER_SIZES = ['small', 'medium', 'large'] as const;
/** The frame an image element reserves (no layout shift): 4:3, 16:9, 1:1, 4:5. */
export const CUSTOM_IMAGE_RATIOS = ['landscape', 'wide', 'square', 'portrait'] as const;
export const MAX_CUSTOM_ELEMENTS_PER_COLUMN = 12;
export const MAX_CUSTOM_HEADING_LENGTH = 120;
export const MAX_CUSTOM_TEXT_LENGTH = 1500;
export const MIN_CUSTOM_CHECKLIST_ITEMS = 1;
export const MAX_CUSTOM_CHECKLIST_ITEMS = 10;
export const MAX_CUSTOM_CHECKLIST_ITEM_LENGTH = 120;
export const MAX_CUSTOM_ICON_TEXT_TITLE_LENGTH = 80;
export const MAX_CUSTOM_ICON_TEXT_LENGTH = 240;
export const MAX_CUSTOM_VIDEO_TITLE_LENGTH = 100;

/** `courseSpotlight`: how many syllabus sections it may list — matches the frontend `MIN/MAX_SPOTLIGHT_MODULES`. */
export const MIN_SPOTLIGHT_MODULES = 1;
export const MAX_SPOTLIGHT_MODULES = 12;

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
  // Theme 3 — Manara (frontend repo, Reports/THEME_3_MANARA_PLAN.md).
  'manara',
  // Theme 4 — Riwaq (frontend repo, Reports/THEME_4_RIWAQ_PLAN.md).
  'riwaq',
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
