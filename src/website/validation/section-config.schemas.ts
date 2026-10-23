/**
 * Section configuration validation schemas — the real security boundary
 * (master plan §5.10: "every write to `sections` must be validated
 * server-side against the exact discriminated-union shape ... the real
 * stored-content-injection boundary").
 *
 * A field-for-field backend reproduction of the real frontend's
 * `atlas-front/src/features/website/schemas/website-section.schemas.ts` —
 * same field names, same bounds, same enums, same `SECTION_SCHEMAS` map
 * keyed by `SectionType`. Never a looser or "subtly different"
 * reinterpretation: a payload this file accepts is a payload the
 * frontend's own `getSectionConfigSchema` would also accept, and vice
 * versa, for every structural/bound check that does not require a
 * database lookup (id-reference existence is handled separately —
 * see `section-reference-validator.service.ts` — because Zod's synchronous
 * schema has no database access, unlike this validation's asynchronous
 * server-side counterpart).
 *
 * Phase 6 (Bilingual Academy Websites) — every field a website VISITOR
 * actually reads as copy is now `LocalizedText { en, ar }`, not a plain
 * string: `hero.title`, `about.body`, CTA labels, statistic labels, etc.
 * Fields that are references, enums, or technical values (`id`, `mode`,
 * `layout`, `courseIds`, `url`, `email`, `phone`, `image` src, `icon`) stay
 * plain scalars — translating a URL or an enum key makes no sense. A
 * proper name (`testimonial.authorName`) also stays a plain scalar — a
 * person's name is not "translated" the way a job title or a sentence is.
 *
 * Deliberately looser than the FAQ/Testimonial LIBRARY content's own
 * `localizedText` helper (`website-content.schemas.ts`), which requires
 * BOTH `en` and `ar` non-empty: a page-embedded section is allowed to have
 * an incomplete Arabic side (`ar: ''`) exactly as Revision 1 of the
 * Bilingual Academy Websites specification requires — "English is the one
 * required-complete language; Arabic degrades gracefully to it" — the
 * renderer's own `resolveLocalizedText` (`localized-text.util.ts`) already
 * falls back to `en` whenever `ar` is blank, so an incomplete translation
 * never produces a broken or empty page.
 *
 * Backward compatible with every Academy created before this phase: every
 * one of these fields accepts EITHER the new `{ en, ar }` object OR a
 * bare legacy string (every section field was a bare string before this
 * phase) via `coerceLegacyLocalized` — a legacy string is treated as
 * pre-existing English content with Arabic not yet translated (`{ en:
 * value, ar: '' }`), which is both true and exactly what the CMS's own
 * completeness indicator should show for it. This is a pure
 * validation-layer widening: `sections`/`header`/`footer`/`seo` are all
 * already `Json` columns (`schema.prisma`), so no database migration is
 * needed or performed.
 *
 * WRITES ONLY. These schemas run on every page write
 * (`WebsitePagesService.update`, `WebsiteGenerationService`); no read path
 * (`website-page.contract.ts`, the public pages payload, publish) parses
 * stored sections against them. That is what lets the content limits in
 * `website.constants.ts` tighten without a migration: content stored
 * under an older, looser limit keeps loading and rendering, and is only
 * refused — with a path-level violation per field — when a page holding
 * it is next saved.
 */
import { z } from 'zod';
import {
  COURSE_CATALOG_SORT_VALUES,
  CTA_PHONE_NUMBER_PATTERN,
  CTA_STYLES,
  CTA_WHATSAPP_NUMBER_PATTERN,
  FEATURE_ICON_OPTIONS,
  MAX_CHIP_TEXT,
  MAX_COURSE_CATALOG_PAGE_SIZE,
  MAX_CTA_LABEL_LENGTH,
  MAX_CTA_WHATSAPP_MESSAGE_LENGTH,
  MAX_FEATURE_SPLIT_ITEMS,
  MAX_HERO_DESCRIPTION_LENGTH,
  MAX_HERO_EYEBROW_LENGTH,
  MAX_HERO_HIGHLIGHTS,
  MAX_HERO_SUBTITLE_LENGTH,
  MAX_HERO_TITLE_LENGTH,
  MAX_LOGOS,
  MAX_LONG_TEXT,
  MAX_MAP_ADDRESS_LENGTH,
  MAX_MAP_NOTE_LENGTH,
  MAX_MAP_QUERY_LENGTH,
  MAX_RESULT_VALUE_LENGTH,
  MAX_RESULTS,
  MAX_SCHEDULE_ROW_DETAIL_LENGTH,
  MAX_SCHEDULE_ROW_TITLE_LENGTH,
  MAX_SCHEDULE_ROWS,
  MAX_SECTION_ITEMS,
  MAX_SECTION_STEPS,
  MAX_SHORT_TEXT,
  MAX_STATISTIC_LABEL_LENGTH,
  MAX_STATISTIC_VALUE_LENGTH,
  MAX_STATISTICS_TITLE_LENGTH,
  MAX_STEP_DESCRIPTION_LENGTH,
  MAX_STEP_TITLE_LENGTH,
  MAX_STEPS_DESCRIPTION_LENGTH,
  MAX_SPOTLIGHT_MODULES,
  MIN_SPOTLIGHT_MODULES,
  MAX_STEPS_TITLE_LENGTH,
  MIN_COURSE_CATALOG_PAGE_SIZE,
  MIN_COURSE_CATEGORIES,
  SECTION_ALIGNMENTS,
  SECTION_BACKGROUNDS,
  SECTION_SPACINGS,
  SCHEDULE_DAYS,
  SCHEDULE_TIME_PATTERN,
  SECTION_TYPES,
  SECTION_WIDTHS,
  MAX_COUNTDOWN_DESCRIPTION_LENGTH,
  MAX_COUNTDOWN_ENDED_MESSAGE_LENGTH,
  MAX_COUNTDOWN_TITLE_LENGTH,
  MAX_PRICING_BADGE_LENGTH,
  MAX_PRICING_DESCRIPTION_LENGTH,
  MAX_PRICING_FEATURE_LENGTH,
  MAX_PRICING_FEATURES,
  MAX_PRICING_PERIOD_LENGTH,
  MAX_PRICING_PLAN_DESCRIPTION_LENGTH,
  MAX_PRICING_PLAN_NAME_LENGTH,
  MAX_PRICING_PLANS,
  MAX_PRICING_PRICE_LENGTH,
  MAX_TIME_ZONE_LENGTH,
  MAX_VIDEO_CAPTION_LENGTH,
  MAX_VIDEO_DESCRIPTION_LENGTH,
  MAX_WHATSAPP_BAR_DESCRIPTION_LENGTH,
  MAX_WHATSAPP_BAR_TITLE_LENGTH,
  MIN_PRICING_PLANS,
  TIME_ZONE_PATTERN,
  CERTIFICATE_YEAR_PATTERN,
  MAX_CERTIFICATES,
  MAX_DOWNLOAD_DESCRIPTION_LENGTH,
  MAX_DOWNLOAD_FILE_SIZE_LENGTH,
  MAX_DOWNLOAD_FILE_TYPE_LENGTH,
  MAX_DOWNLOAD_TITLE_LENGTH,
  MAX_DOWNLOAD_URL_LENGTH,
  MAX_DOWNLOADS,
  MAX_TIMELINE_MILESTONE_DESCRIPTION_LENGTH,
  MAX_TIMELINE_MILESTONE_TITLE_LENGTH,
  MAX_TIMELINE_MILESTONES,
  MAX_TIMELINE_PERIOD_LENGTH,
  MAX_VIDEO_TESTIMONIAL_QUOTE_LENGTH,
  MAX_VIDEO_TESTIMONIAL_ROLE_LENGTH,
  MAX_VIDEO_TESTIMONIALS,
  ANNOUNCEMENT_TONES,
  COMPARISON_CELL_VALUES,
  INTEREST_FIELD_MODES,
  MAX_ANNOUNCEMENT_TEXT_LENGTH,
  MAX_COMPARISON_CELL_TEXT_LENGTH,
  MAX_COMPARISON_COLUMN_LABEL_LENGTH,
  MAX_COMPARISON_COLUMNS,
  MAX_COMPARISON_DESCRIPTION_LENGTH,
  MAX_COMPARISON_ROW_LABEL_LENGTH,
  MAX_COMPARISON_ROWS,
  MAX_INTEREST_CHOICE_LABEL_LENGTH,
  MAX_INTEREST_FORM_DESCRIPTION_LENGTH,
  MAX_INTEREST_OPTION_LENGTH,
  MAX_INTEREST_OPTIONS,
  MAX_INTEREST_SUCCESS_MESSAGE_LENGTH,
  MIN_COMPARISON_COLUMNS,
} from '../constants/website.constants';
import {
  DEFAULT_PUBLIC_WEBSITE_LOCALE,
  type PublicWebsiteLocale,
} from '../constants/locale.constants';
import { isAllowedImageValue } from './image-value.util';
import { isSafeExternalUrl } from './url-safety.util';
import {
  isCountdownDeadlineOrEmpty,
  isDownloadLinkOrEmpty,
  isYouTubeVideoIdOrEmpty,
  normalizeYouTubeVideoInput,
} from './section-media-values.util';

export const sectionTypeSchema = z.enum(SECTION_TYPES);

const responsiveVisibilitySchema = z.object({
  desktop: z.boolean(),
  tablet: z.boolean(),
  mobile: z.boolean(),
});

/** A bare string (every section field, pre-Phase-6) becomes pre-existing English content with Arabic not yet translated — never dropped, never duplicated into a mislabeled "Arabic" that isn't. Already-shaped `{en, ar}` input, or `undefined` for an optional field, passes through untouched. Exported so `website-config.schemas.ts` (header/footer/navigation/SEO) applies the exact same widening rule, not a second reinterpretation of it. */
export function coerceLegacyLocalized(value: unknown): unknown {
  return typeof value === 'string' ? { en: value, ar: '' } : value;
}

/*
 * ARABIC IS OPTIONAL, AND THAT HAS TO INCLUDE BEING ABSENT.
 *
 * Both schemas below used to declare `ar` as a plain required key that was
 * merely allowed to be an empty string. Empty was fine; MISSING was a hard
 * validation error — and the editor omits a translation the user never
 * touched, which is the normal case for an academy that writes in English
 * first. The result, reproduced in production: fill in the English title
 * and body exactly as the form invites (its Arabic fields are labelled
 * "العربية • اختياري", Arabic • optional, with "لم تتم الترجمة بعد"
 * underneath), press Save, and the save is refused.
 *
 * The intent was never in doubt — the comment on `localizedRequired` said
 * "`ar` may be empty ... it never blocks a save", and
 * `coerceLegacyLocalized` right above widens a bare legacy string to
 * `{en, ar: ''}`. Both say a missing Arabic translation means an empty
 * one. `.default('')` is what makes the schema say it too, and it keeps
 * the parsed shape exactly as before, so every reader downstream still
 * gets a `{en, ar}` pair and nothing else changes.
 */
const optionalArabic = (maxLength: number) =>
  z.string().max(maxLength, 'validation:maxLength').default('');

/*
 * B0-WEB-02 — WHICH LANGUAGE IS REQUIRED FOLLOWS THE SITE'S DEFAULT.
 *
 * On an English-default site (every site until now, and still the default)
 * English is the required language and Arabic optional. On an
 * Arabic-default site the two swap: Arabic is required and English may be
 * empty or absent. The schemas below are module-level constants shared by
 * every caller, so the direction is supplied around the parse rather than
 * baked into a second copy of every section schema: `withRequiredLocale`
 * sets it for one synchronous parse (zod's `safeParse` is synchronous, so
 * nothing else can run in between) and `localizedRequired` reads it when it
 * parses. Outside `withRequiredLocale` it is `en`, which is exactly the
 * schema this was before.
 */
let requiredLocale: PublicWebsiteLocale = DEFAULT_PUBLIC_WEBSITE_LOCALE;

/** Runs `parse` (a synchronous zod parse) with `locale` as the language every `localizedRequired` field must fill. */
export function withRequiredLocale<T>(locale: PublicWebsiteLocale, parse: () => T): T {
  const previous = requiredLocale;
  requiredLocale = locale;
  try {
    return parse();
  } finally {
    requiredLocale = previous;
  }
}

/** `en` is required non-empty (the one always-complete language); `ar` may be empty or absent — an incomplete translation degrades to `en` at render time, it never blocks a save. On an Arabic-default site the roles swap (see `withRequiredLocale`). */
export const localizedRequired = (maxLength: number) => {
  const englishRequired = z.preprocess(
    coerceLegacyLocalized,
    z.object({
      en: z.string().min(1, 'validation:required').max(maxLength, 'validation:maxLength'),
      ar: optionalArabic(maxLength),
    }),
  );
  const arabicRequired = z.preprocess(
    coerceLegacyLocalized,
    z.object({
      en: z.string().max(maxLength, 'validation:maxLength').default(''),
      ar: z.string().min(1, 'validation:required').max(maxLength, 'validation:maxLength'),
    }),
  );
  return z.lazy(() =>
    requiredLocale === 'ar'
      ? (arabicRequired as unknown as typeof englishRequired)
      : englishRequired,
  );
};

/** Neither key is required to be non-empty — matches the field's own plain-string equivalent already being optional-content (e.g. a `description` that may be blank). */
export const localizedOptional = (maxLength: number) =>
  z.preprocess(
    coerceLegacyLocalized,
    z.object({
      en: z.string().max(maxLength, 'validation:maxLength').default(''),
      ar: optionalArabic(maxLength),
    }),
  );

export const localizedTextFieldSchema = localizedOptional(MAX_LONG_TEXT);
export type ValidatedLocalizedText = z.infer<typeof localizedTextFieldSchema>;

/**
 * One section button — matches the frontend's `websiteCtaSchema` exactly.
 * The label cap applies to every section CTA (hero, FAQ, CTA banner,
 * feature split, about). `url` is checked against `isSafeExternalUrl` in
 * addition to being syntactically a URL.
 *
 * `authAction` (the Academy's own Sign In/Sign Up) is written by
 * `WebsiteGenerationService` into every generated site's CTAs. It was
 * missing here, and this schema strips keys it does not know, so the first
 * save of a generated page dropped it and the "Sign up" button lost its
 * target and vanished from the public site. `whatsapp`/`phone` are stored
 * as numbers, never as a URL: the renderer builds the `wa.me`/`tel:` link,
 * so nothing a tenant types becomes an `href` unchecked. Empty is a button
 * whose number is not typed yet (like an empty `url`): it saves, and the
 * public site leaves it out until it has one. `style` absent
 * means the theme's own look for the button's position.
 */
const websiteCtaSchema = z.object({
  label: localizedRequired(MAX_CTA_LABEL_LENGTH),
  pageId: z.string().optional(),
  courseId: z.string().optional(),
  url: z
    .string()
    .url('validation:invalidUrl')
    .refine(isSafeExternalUrl, { message: 'validation:invalidUrl' })
    .optional()
    .or(z.literal('')),
  authAction: z.enum(['signIn', 'signUp']).optional(),
  whatsapp: z
    .string()
    .regex(CTA_WHATSAPP_NUMBER_PATTERN, 'validation:invalidWhatsappNumber')
    .optional()
    .or(z.literal('')),
  whatsappMessage: localizedOptional(MAX_CTA_WHATSAPP_MESSAGE_LENGTH).optional(),
  phone: z
    .string()
    .regex(CTA_PHONE_NUMBER_PATTERN, 'validation:invalidCallNumber')
    .optional()
    .or(z.literal('')),
  style: z.enum(CTA_STYLES).optional(),
});

/** Any image field — see `image-value.util.ts` for what's allowed and why. */
const imageValueSchema = z
  .string()
  .refine(isAllowedImageValue, { message: 'validation:invalidImage' });

/** Theme 1 plan §C.1 — a short label chip under the hero (e.g. "Certificates"). */
const heroHighlightSchema = z.object({
  id: z.string(),
  label: localizedRequired(MAX_CHIP_TEXT),
});

/** Content limits: see `website.constants.ts` ("Section content limits"). */
export const heroSectionSchema = z.object({
  eyebrow: localizedOptional(MAX_HERO_EYEBROW_LENGTH).optional(),
  title: localizedRequired(MAX_HERO_TITLE_LENGTH),
  subtitle: localizedOptional(MAX_HERO_SUBTITLE_LENGTH).optional(),
  description: localizedOptional(MAX_HERO_DESCRIPTION_LENGTH).optional(),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
  /** Theme 1 plan §D.2 — the one title phrase a theme may emphasise; ignored if it's no longer in the title. */
  highlight: localizedOptional(MAX_HERO_TITLE_LENGTH).optional(),
  highlights: z.array(heroHighlightSchema).max(MAX_HERO_HIGHLIGHTS).optional(),
  /** Inline course search in the hero (submits to the catalog, `/courses?q=`). */
  showSearch: z.boolean().optional(),
});

export const aboutSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  body: localizedRequired(MAX_LONG_TEXT),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
});

export const featuredCoursesSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  mode: z.enum(['latest', 'selected']),
  courseIds: z.array(z.string()).optional(),
  layout: z.enum(['grid', 'carousel']),
  count: z.number().int().min(1).max(MAX_SECTION_ITEMS),
  showPrice: z.boolean(),
  showInstructor: z.boolean(),
});

/** P64 Phase 4 §E.1 — mirrors the frontend `courseCatalogSectionSchema` field for field. */
export const courseCatalogSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  pageSize: z
    .number()
    .int()
    .min(MIN_COURSE_CATALOG_PAGE_SIZE)
    .max(MAX_COURSE_CATALOG_PAGE_SIZE),
  defaultSort: z.enum(COURSE_CATALOG_SORT_VALUES),
  showSearch: z.boolean(),
  showLevelFilter: z.boolean(),
  showPricingFilter: z.boolean(),
  showSort: z.boolean(),
});

const statisticItemSchema = z
  .object({
    id: z.string(),
    /**
     * Deliberately localized, not just numeral-formatted: an Owner may want distinct copy per language (e.g. "500+" vs "٥٠٠+", or a differently-worded suffix), not a locale-conversion of one authored value.
     *
     * Theme 1 plan §D.4 — may be empty when `metric` is set: a live item's number is resolved at render time, so starter content never carries a hand-typed one. Without `metric` the value IS the item and stays required.
     */
    value: localizedOptional(MAX_STATISTIC_VALUE_LENGTH),
    label: localizedRequired(MAX_STATISTIC_LABEL_LENGTH),
    /** Present only when generated (§1.4/§6.2 of the specification) — resolves a real, live, Academy-scoped count instead of the static `value` above. Absent means "use the authored `value` as-is," matching today's manually-authored behavior exactly. */
    metric: z.enum(['courses', 'students', 'instructors']).optional(),
  })
  .refine((item) => !!item.metric || item.value.en.trim().length > 0, {
    message: 'validation:required',
    path: ['value', 'en'],
  });

export const statisticsSectionSchema = z.object({
  title: localizedOptional(MAX_STATISTICS_TITLE_LENGTH).optional(),
  items: z.array(statisticItemSchema).max(MAX_SECTION_ITEMS),
});

const featureItemSchema = z.object({
  id: z.string(),
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT),
  icon: z.enum(FEATURE_ICON_OPTIONS as [string, ...string[]]),
});

export const featuresSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(featureItemSchema).max(MAX_SECTION_ITEMS),
  /** Theme 1 plan §D.2 — `strip` is a compact highlights band; absent means today's cards. */
  layout: z.enum(['cards', 'strip']).optional(),
});

const testimonialItemSchema = z.object({
  id: z.string(),
  quote: localizedRequired(MAX_LONG_TEXT),
  /** A proper name — not translated, matches the FAQ/Testimonial library's own `authorName` precedent (`website-content.schemas.ts`). */
  authorName: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  authorRole: localizedOptional(MAX_SHORT_TEXT).optional(),
  avatar: imageValueSchema.optional(),
  avatarAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  /**
   * Theme 1 plan §D.4 — starter content for preview/design only. Never
   * public: the public pages payload strips it, publish warns about it, and
   * only the Owner's explicit "This is a real testimonial" clears it.
   */
  sample: z.boolean().optional(),
});

export const testimonialsSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  items: z.array(testimonialItemSchema).max(MAX_SECTION_ITEMS),
  // `libraryEntryIds` references the CMS content library: existence in this
  // Academy is checked on write (`SectionReferenceValidatorService`), and
  // the public pages payload expands them (published + visible only) into
  // `libraryEntries` (`PublicWebsiteService`). A client-sent
  // `libraryEntries` is not part of this schema, so it is stripped.
  libraryEntryIds: z.array(z.string()).max(MAX_SECTION_ITEMS).optional(),
});

const faqItemSchema = z.object({
  id: z.string(),
  question: localizedRequired(MAX_SHORT_TEXT),
  answer: localizedRequired(MAX_LONG_TEXT),
});

export const faqSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  items: z.array(faqItemSchema).max(MAX_SECTION_ITEMS),
  libraryEntryIds: z.array(z.string()).max(MAX_SECTION_ITEMS).optional(),
  /** Theme 1 plan §D.2 — show only the first N (a teaser), with a link to the rest. */
  maxItems: z.number().int().min(1).max(MAX_SECTION_ITEMS).optional(),
  cta: websiteCtaSchema.optional(),
});

export const ctaSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  cta: websiteCtaSchema,
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
});

export const instructorsSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  count: z.number().int().min(1).max(MAX_SECTION_ITEMS),
});

const galleryImageSchema = z.object({
  id: z.string(),
  image: imageValueSchema.pipe(z.string().min(1, 'validation:required')),
  caption: localizedOptional(MAX_SHORT_TEXT).optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
});

export const gallerySectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  images: z.array(galleryImageSchema).max(MAX_SECTION_ITEMS),
});

/**
 * `email`/`phone`/`address` stay plain scalars, on purpose — they are
 * factual reference data (and, per §1.4, usually left blank so this
 * section falls back to the Academy's own real `contactEmail`/
 * `contactPhone`/`address` fields, which are themselves plain scalars on
 * the `Academy` model today, not `LocalizedText`) rather than authored
 * copy a translator would rewrite per language.
 */
export const contactSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  email: z.string().email('validation:invalidEmail').optional().or(z.literal('')),
  phone: z.string().max(30, 'validation:maxLength').optional(),
  address: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  showForm: z.boolean(),
});

/**
 * Theme 1 plan §D.2 — an inner page's title band (Courses, About, FAQs,
 * Contact). `search` puts the page's own search in it: the course catalog
 * or the FAQ filter.
 */
export const pageHeaderSectionSchema = z.object({
  eyebrow: localizedOptional(MAX_SHORT_TEXT).optional(),
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  search: z.enum(['none', 'courses', 'faq']).optional(),
});

/** Theme 1 plan §C.1 #3 — the Academy's real categories (live); hidden publicly with fewer than two. */
export const courseCategoriesSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  maxItems: z.number().int().min(MIN_COURSE_CATEGORIES).max(MAX_SECTION_ITEMS),
  showCounts: z.boolean(),
});

const stepItemSchema = z.object({
  id: z.string(),
  title: localizedRequired(MAX_STEP_TITLE_LENGTH),
  description: localizedOptional(MAX_STEP_DESCRIPTION_LENGTH).optional(),
});

/**
 * Theme 1 plan §C.1 #6 — "How it works": an ordered, numbered sequence.
 * `image`/`imageAlt` validate exactly like `featureSplit`'s: an optional
 * plate drawn by themes that support it (Atelier's Method scene); Theme 1
 * ignores it.
 */
export const stepsSectionSchema = z.object({
  title: localizedOptional(MAX_STEPS_TITLE_LENGTH).optional(),
  description: localizedOptional(MAX_STEPS_DESCRIPTION_LENGTH).optional(),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  items: z.array(stepItemSchema).max(MAX_SECTION_STEPS),
});

const featureSplitItemSchema = z.object({
  id: z.string(),
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
});

/** Theme 1 plan §C.1 #5 / §C.4 — an image beside a title, lead and numbered benefits. */
export const featureSplitSectionSchema = z.object({
  eyebrow: localizedOptional(MAX_SHORT_TEXT).optional(),
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  image: imageValueSchema.optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  /** Logical side: `start` is left in English and right in Arabic. */
  imagePosition: z.enum(['start', 'end']),
  items: z.array(featureSplitItemSchema).max(MAX_FEATURE_SPLIT_ITEMS),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
});

/**
 * Theme 4 plan §6 — one real course's outcomes and syllabus. `courseId`
 * references the Academy's own Course domain (checked by
 * `SectionReferenceValidatorService`, like `featuredCourses.courseIds`);
 * absent means "the newest published course". Every fact it shows is read
 * live from the public course and its curriculum — the config carries no
 * course copy of its own.
 */
export const courseSpotlightSectionSchema = z.object({
  eyebrow: localizedOptional(MAX_SHORT_TEXT).optional(),
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  courseId: z.string().min(1).optional(),
  showOutcomes: z.boolean(),
  showSyllabus: z.boolean(),
  maxModules: z.number().int().min(MIN_SPOTLIGHT_MODULES).max(MAX_SPOTLIGHT_MODULES),
  cta: websiteCtaSchema.optional(),
});

/**
 * A plain web address a tenant typed (a logo's link) — exactly the section
 * button's `url` rule: a real URL whose scheme `isSafeExternalUrl` allows,
 * or empty (no link).
 */
const optionalSafeUrlSchema = z
  .string()
  .url('validation:invalidUrl')
  .refine(isSafeExternalUrl, { message: 'validation:invalidUrl' })
  .optional()
  .or(z.literal(''));

const logoItemSchema = z.object({
  id: z.string(),
  /** Required: a logo without its image is not a logo. Same image rule as every image field. */
  image: imageValueSchema.pipe(z.string().min(1, 'validation:required')),
  /** The partner's name as a screen reader announces it (and the link's name when linked). */
  alt: localizedRequired(MAX_SHORT_TEXT),
  url: optionalSafeUrlSchema,
});

/** CMS phase 3d — partner / accreditation logos: a calm wrapping grid, never a marquee. */
export const logosSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(logoItemSchema).max(MAX_LOGOS),
});

/**
 * CMS phase 3d — where the academy is. `address` is the visible card
 * (multi-line); `query` (an address or `lat,lng`) feeds the map and the
 * directions link and falls back to the address when empty. It is never
 * an `href` itself: the renderer encodes it into a fixed Google Maps URL.
 */
export const mapSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  address: localizedRequired(MAX_MAP_ADDRESS_LENGTH),
  note: localizedOptional(MAX_MAP_NOTE_LENGTH).optional(),
  query: z.string().max(MAX_MAP_QUERY_LENGTH, 'validation:maxLength').optional(),
});

const scheduleTimeSchema = z
  .string()
  .regex(SCHEDULE_TIME_PATTERN, 'validation:invalidTime');

const scheduleRowSchema = z
  .object({
    id: z.string(),
    day: z.enum(SCHEDULE_DAYS),
    start: scheduleTimeSchema,
    end: scheduleTimeSchema,
    /** The course or group meeting at that time. */
    title: localizedRequired(MAX_SCHEDULE_ROW_TITLE_LENGTH),
    teacher: localizedOptional(MAX_SCHEDULE_ROW_DETAIL_LENGTH).optional(),
    location: localizedOptional(MAX_SCHEDULE_ROW_DETAIL_LENGTH).optional(),
    /** Starter row for preview only — never public (see `sample-content.util.ts`). */
    sample: z.boolean().optional(),
  })
  // `HH:MM` compares correctly as text.
  .refine((row) => row.end > row.start, {
    message: 'validation:endAfterStart',
    path: ['end'],
  });

/** CMS phase 3d — a weekly timetable, shown by day (Saturday first). */
export const scheduleSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(scheduleRowSchema).max(MAX_SCHEDULE_ROWS),
});

const resultItemSchema = z.object({
  id: z.string(),
  /** A proper name — not translated, like `testimonial.authorName`. */
  studentName: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  /** The achievement itself ("98%", "الأول على الجمهورية"). */
  result: localizedRequired(MAX_RESULT_VALUE_LENGTH),
  /** Grade, year or exam ("Thanaweya Amma 2025"). */
  detail: localizedOptional(MAX_SHORT_TEXT).optional(),
  photo: imageValueSchema.optional(),
  photoAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  /** Marks a top achiever (drawn with a badge, never by colour alone). */
  top: z.boolean().optional(),
  /**
   * Starter content for preview/design only — exactly the testimonials'
   * rule: the public pages payload strips it, publish warns about it, and
   * only the Owner's explicit "This is a real result" clears it.
   */
  sample: z.boolean().optional(),
});

/** CMS phase 3d — student results and achievements ("أوائل"). */
export const resultsSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(resultItemSchema).max(MAX_RESULTS),
});

/*
 * CMS phase 3d (batch A) — four sections shared by every theme. Each one
 * mirrors the frontend's identically named schema field for field; the
 * parity cases prove it, including that every field survives the parse.
 */

/** A "Talk to us" strip: a short line and up to three buttons (WhatsApp, a call, a page). */
export const whatsappBarSectionSchema = z.object({
  title: localizedRequired(MAX_WHATSAPP_BAR_TITLE_LENGTH),
  description: localizedOptional(MAX_WHATSAPP_BAR_DESCRIPTION_LENGTH).optional(),
  cta: websiteCtaSchema,
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
});

/**
 * A YouTube video that loads only when the visitor presses play. A pasted
 * link in any common form is reduced to its 11-character id
 * (`normalizeYouTubeVideoInput`); only the id is stored, and the public site
 * builds every YouTube address from it. Empty is a video not chosen yet: it
 * saves, and the public site leaves the section out until it has one.
 */
export const videoSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_VIDEO_DESCRIPTION_LENGTH).optional(),
  videoId: z.preprocess(
    normalizeYouTubeVideoInput,
    z.string().refine(isYouTubeVideoIdOrEmpty, {
      message: 'validation:invalidYouTubeVideo',
    }),
  ),
  /** An uploaded poster instead of YouTube's own thumbnail. */
  poster: imageValueSchema.optional(),
  caption: localizedOptional(MAX_VIDEO_CAPTION_LENGTH).optional(),
});

const pricingFeatureSchema = z.object({
  id: z.string(),
  text: localizedRequired(MAX_PRICING_FEATURE_LENGTH),
  /** ✓ when the plan includes it, ✗ when it does not. */
  included: z.boolean(),
});

const pricingPlanSchema = z.object({
  id: z.string(),
  name: localizedRequired(MAX_PRICING_PLAN_NAME_LENGTH),
  /** Free text in each language ("450 ج.م", "Free") — never a number the site formats. */
  price: localizedRequired(MAX_PRICING_PRICE_LENGTH),
  period: localizedOptional(MAX_PRICING_PERIOD_LENGTH).optional(),
  description: localizedOptional(MAX_PRICING_PLAN_DESCRIPTION_LENGTH).optional(),
  features: z.array(pricingFeatureSchema).max(MAX_PRICING_FEATURES),
  /** The "most popular" plan; the editor keeps it to one. */
  highlighted: z.boolean().optional(),
  badge: localizedOptional(MAX_PRICING_BADGE_LENGTH).optional(),
  /** The plan's one button — the same targets as any section button (checked by `SectionReferenceValidatorService`). */
  cta: websiteCtaSchema.optional(),
});

/** Plans or packages (monthly, per term): one to four. */
export const pricingSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_PRICING_DESCRIPTION_LENGTH).optional(),
  plans: z.array(pricingPlanSchema).min(MIN_PRICING_PLANS).max(MAX_PRICING_PLANS),
});

/**
 * A countdown to a registration deadline. `deadline` is an ISO date and
 * time with its offset (the moment); `timeZone` is the academy's IANA zone
 * the deadline was chosen in, so the site can say it in that zone. Empty is
 * a deadline not chosen yet: it saves, and the public site leaves the
 * section out until it has one.
 */
export const countdownSectionSchema = z.object({
  title: localizedRequired(MAX_COUNTDOWN_TITLE_LENGTH),
  description: localizedOptional(MAX_COUNTDOWN_DESCRIPTION_LENGTH).optional(),
  deadline: z.string().refine(isCountdownDeadlineOrEmpty, {
    message: 'validation:invalidDeadline',
  }),
  timeZone: z
    .string()
    .max(MAX_TIME_ZONE_LENGTH, 'validation:maxLength')
    .regex(TIME_ZONE_PATTERN, 'validation:invalid')
    .optional(),
  /** Shown instead of the countdown once the deadline has passed. */
  endedMessage: localizedOptional(MAX_COUNTDOWN_ENDED_MESSAGE_LENGTH).optional(),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
  tertiaryCta: websiteCtaSchema.optional(),
});

/*
 * CMS phase 3d (batch C) — three sections shared by every theme, each
 * mirroring the frontend's identically named schema field for field (the
 * parity cases prove it, including that every field survives the parse).
 */

const interestOptionSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  label: localizedRequired(MAX_INTEREST_OPTION_LENGTH),
});

/**
 * "Register your interest": a lead form that reaches the academy's
 * Messages through the contact form's own endpoint
 * (`POST public/websites/:academyId/contact`, `kind: 'interest'`). Name and
 * phone are always asked; email, the choice list and a message are each
 * hidden, optional or required. A choice list with no options is not shown
 * (and the public endpoint treats it as hidden). The endpoint reads this
 * config from the PUBLISHED page to decide what it accepts: a chosen option
 * must be one of `options` by id.
 */
export const interestFormSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_INTEREST_FORM_DESCRIPTION_LENGTH).optional(),
  emailField: z.enum(INTEREST_FIELD_MODES),
  choiceField: z.enum(INTEREST_FIELD_MODES),
  /** The choice list's label ("Course", "Grade"); empty → "Your choice". */
  choiceLabel: localizedOptional(MAX_INTEREST_CHOICE_LABEL_LENGTH).optional(),
  options: z.array(interestOptionSchema).max(MAX_INTEREST_OPTIONS),
  messageField: z.enum(INTEREST_FIELD_MODES),
  /** Empty → "Send". */
  submitLabel: localizedOptional(MAX_CTA_LABEL_LENGTH).optional(),
  /** Shown (and announced) once the form is sent; empty → a standard thank-you. */
  successMessage: localizedOptional(MAX_INTEREST_SUCCESS_MESSAGE_LENGTH).optional(),
});

/**
 * A slim notice strip ("Registration for 2026/2027 is open"): a short line,
 * an optional single button (the section button contract, in the `cta`
 * slot) and a named tone each theme draws from its own palette. Never
 * dismissible and never moving, so an edge-cached page is the same for
 * every visitor.
 */
export const announcementBarSectionSchema = z.object({
  text: localizedRequired(MAX_ANNOUNCEMENT_TEXT_LENGTH),
  tone: z.enum(ANNOUNCEMENT_TONES),
  cta: websiteCtaSchema.optional(),
});

const comparisonColumnSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  label: localizedRequired(MAX_COMPARISON_COLUMN_LABEL_LENGTH),
  /** The column to draw attention to; the editor keeps it to one (the site draws the first). */
  highlighted: z.boolean().optional(),
});

/** One cell: ✓, ✗ or a short text. `column` is the id of the column it sits in. */
const comparisonCellSchema = z.discriminatedUnion('value', [
  z.object({ column: z.string().min(1), value: z.literal(COMPARISON_CELL_VALUES[0]) }),
  z.object({ column: z.string().min(1), value: z.literal(COMPARISON_CELL_VALUES[1]) }),
  z.object({
    column: z.string().min(1),
    value: z.literal(COMPARISON_CELL_VALUES[2]),
    text: localizedRequired(MAX_COMPARISON_CELL_TEXT_LENGTH),
  }),
]);

const comparisonRowSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  label: localizedRequired(MAX_COMPARISON_ROW_LABEL_LENGTH),
  /** At most one per column; a column without a cell shows a dash. */
  cells: z.array(comparisonCellSchema).max(MAX_COMPARISON_COLUMNS),
});

/**
 * A comparison table ("Our academy vs studying alone", or plans): two to
 * four columns, up to fifteen rows, each cell ✓ / ✗ / short text. Every
 * cell must name one of the section's columns, once per row.
 */
export const comparisonSectionSchema = z
  .object({
    title: localizedRequired(MAX_SHORT_TEXT),
    description: localizedOptional(MAX_COMPARISON_DESCRIPTION_LENGTH).optional(),
    columns: z
      .array(comparisonColumnSchema)
      .min(MIN_COMPARISON_COLUMNS)
      .max(MAX_COMPARISON_COLUMNS),
    rows: z.array(comparisonRowSchema).max(MAX_COMPARISON_ROWS),
  })
  .superRefine((config, ctx) => {
    const columnIds = new Set(config.columns.map((column) => column.id));
    config.rows.forEach((row, rowIndex) => {
      const seen = new Set<string>();
      row.cells.forEach((cell, cellIndex) => {
        if (!columnIds.has(cell.column) || seen.has(cell.column)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'validation:invalid',
            path: ['rows', rowIndex, 'cells', cellIndex, 'column'],
          });
        }
        seen.add(cell.column);
      });
    });
  });

/*
 * CMS phase 3d (batch D) — four sections shared by every theme, each
 * mirroring the frontend's identically named schema field for field (the
 * parity cases prove it, including that every field survives the parse).
 */

/** A YouTube link in any common form, stored as its 11-character id; empty is a video not chosen yet. */
const youTubeVideoIdSchema = z.preprocess(
  normalizeYouTubeVideoInput,
  z.string().refine(isYouTubeVideoIdOrEmpty, {
    message: 'validation:invalidYouTubeVideo',
  }),
);

const timelineMilestoneSchema = z.object({
  id: z.string(),
  title: localizedRequired(MAX_TIMELINE_MILESTONE_TITLE_LENGTH),
  /** "Sept–Oct", "Term 1" — shown with the milestone, never parsed as a date. */
  period: localizedOptional(MAX_TIMELINE_PERIOD_LENGTH).optional(),
  description: localizedOptional(MAX_TIMELINE_MILESTONE_DESCRIPTION_LENGTH).optional(),
  /** One of the features' curated icons, or empty (the milestone's number is shown). */
  icon: z
    .enum(FEATURE_ICON_OPTIONS as [string, ...string[]])
    .optional()
    .or(z.literal('')),
});

/** A learning path ("Term 1 → Term 2 → Final revision"): an ordered list of milestones. */
export const timelineSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(timelineMilestoneSchema).max(MAX_TIMELINE_MILESTONES),
});

const videoTestimonialItemSchema = z.object({
  id: z.string(),
  /** Empty saves (a starter review); the public site leaves an item without a video out. */
  videoId: youTubeVideoIdSchema,
  /** A proper name — not translated, like `testimonial.authorName`. */
  name: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  /** "Parent of a Grade 12 student". */
  role: localizedRequired(MAX_VIDEO_TESTIMONIAL_ROLE_LENGTH),
  quote: localizedOptional(MAX_VIDEO_TESTIMONIAL_QUOTE_LENGTH).optional(),
  /** An uploaded poster instead of YouTube's own thumbnail. */
  poster: imageValueSchema.optional(),
  /**
   * Starter content for preview only — exactly the testimonials' rule: the
   * public pages payload strips it, publish warns about it, and only the
   * Owner's explicit "This is a real review" clears it.
   */
  sample: z.boolean().optional(),
});

/** Student and parent video reviews: a grid of click-to-play videos. */
export const videoTestimonialsSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(videoTestimonialItemSchema).max(MAX_VIDEO_TESTIMONIALS),
});

const downloadItemSchema = z.object({
  id: z.string(),
  title: localizedRequired(MAX_DOWNLOAD_TITLE_LENGTH),
  description: localizedOptional(MAX_DOWNLOAD_DESCRIPTION_LENGTH).optional(),
  /**
   * A media-library file (`/api/v1/public/media/…`) or an http(s) address
   * `isSafeExternalUrl` allows (`isDownloadLinkOrEmpty`). Empty saves; the
   * public site leaves the item out until it has a link.
   */
  url: z
    .string()
    .max(MAX_DOWNLOAD_URL_LENGTH, 'validation:maxLength')
    .refine(isDownloadLinkOrEmpty, { message: 'validation:invalidDownloadLink' }),
  /** "PDF"; empty → read from the link's file extension. */
  fileType: z
    .string()
    .max(MAX_DOWNLOAD_FILE_TYPE_LENGTH, 'validation:maxLength')
    .optional(),
  /** "2.4 MB". */
  fileSize: z
    .string()
    .max(MAX_DOWNLOAD_FILE_SIZE_LENGTH, 'validation:maxLength')
    .optional(),
});

/** Downloadable resources (PDF notes, revision sheets). */
export const downloadsSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(downloadItemSchema).max(MAX_DOWNLOADS),
});

const certificateItemSchema = z.object({
  id: z.string(),
  /** Required: a certificate without its image is not one. Same image rule as every image field. */
  image: imageValueSchema.pipe(z.string().min(1, 'validation:required')),
  title: localizedRequired(MAX_SHORT_TEXT),
  issuer: localizedOptional(MAX_SHORT_TEXT).optional(),
  /** Four digits ("2025"), or empty. */
  year: z
    .string()
    .regex(CERTIFICATE_YEAR_PATTERN, 'validation:invalidYear')
    .optional()
    .or(z.literal('')),
});

/** Certificates and accreditations: framed images with captions. */
export const certificatesSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  items: z.array(certificateItemSchema).max(MAX_CERTIFICATES),
});

/** Matches the frontend's `SECTION_SCHEMAS` map exactly — one schema per `SectionType`, `satisfies Record<SectionType, ZodTypeAny>`. */
const SECTION_CONFIG_SCHEMAS = {
  hero: heroSectionSchema,
  about: aboutSectionSchema,
  featuredCourses: featuredCoursesSectionSchema,
  courseCatalog: courseCatalogSectionSchema,
  statistics: statisticsSectionSchema,
  features: featuresSectionSchema,
  testimonials: testimonialsSectionSchema,
  faq: faqSectionSchema,
  cta: ctaSectionSchema,
  instructors: instructorsSectionSchema,
  gallery: gallerySectionSchema,
  contact: contactSectionSchema,
  pageHeader: pageHeaderSectionSchema,
  courseCategories: courseCategoriesSectionSchema,
  steps: stepsSectionSchema,
  featureSplit: featureSplitSectionSchema,
  courseSpotlight: courseSpotlightSectionSchema,
  logos: logosSectionSchema,
  map: mapSectionSchema,
  schedule: scheduleSectionSchema,
  results: resultsSectionSchema,
  whatsappBar: whatsappBarSectionSchema,
  video: videoSectionSchema,
  pricing: pricingSectionSchema,
  countdown: countdownSectionSchema,
  timeline: timelineSectionSchema,
  videoTestimonials: videoTestimonialsSectionSchema,
  downloads: downloadsSectionSchema,
  certificates: certificatesSectionSchema,
  interestForm: interestFormSectionSchema,
  announcementBar: announcementBarSectionSchema,
  comparison: comparisonSectionSchema,
} satisfies Record<(typeof SECTION_TYPES)[number], z.ZodTypeAny>;

/** Resolves the right Zod schema for a section type — matches `getSectionConfigSchema`. */
export function getSectionConfigSchema(
  type: (typeof SECTION_TYPES)[number],
): z.ZodTypeAny {
  return SECTION_CONFIG_SCHEMAS[type];
}

/** One base fields shape (`id`/`enabled`/`visibility`) shared by every section instance branch below — factored out so each branch below is a one-liner, never eleven hand-copied field lists. */
/**
 * CMS phase 3 — a section's design: named choices only (see
 * `SECTION_BACKGROUNDS` and friends), matched by the frontend's
 * `sectionDesignSchema`. Every key is optional and absent means the theme's
 * own choice, so every stored section reads as it did.
 */
export const sectionDesignSchema = z.object({
  background: z.enum(SECTION_BACKGROUNDS).optional(),
  spacing: z.enum(SECTION_SPACINGS).optional(),
  /** Phones only; absent = the same as `spacing`. */
  spacingMobile: z.enum(SECTION_SPACINGS).optional(),
  align: z.enum(SECTION_ALIGNMENTS).optional(),
  width: z.enum(SECTION_WIDTHS).optional(),
  /** Phones only: a two-column section stacks its second column first. */
  reverseOnMobile: z.boolean().optional(),
});

const sectionInstanceBase = {
  id: z.string().min(1, 'validation:required'),
  enabled: z.boolean(),
  visibility: responsiveVisibilitySchema,
  design: sectionDesignSchema.optional(),
};

/**
 * One `SectionInstance` — a real discriminated union on `type`, built with
 * `z.discriminatedUnion` so an unregistered/malformed `type` is rejected
 * before its `config` is ever inspected against the wrong schema (matches
 * `SectionInstance`'s TypeScript mapped-type discriminated union,
 * `website-section.types.ts`). Each branch is written out explicitly
 * (rather than derived via a runtime loop over `SECTION_TYPES`) so
 * TypeScript keeps full per-branch narrowing on `z.infer` — a dynamically
 * built union loses that, and `SectionReferenceValidatorService` relies on
 * it to read `section.config.courseIds`/`.cta` without a cast.
 */
export const sectionInstanceSchema = z.discriminatedUnion('type', [
  z.object({
    ...sectionInstanceBase,
    type: z.literal('hero'),
    config: heroSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('about'),
    config: aboutSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('featuredCourses'),
    config: featuredCoursesSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('courseCatalog'),
    config: courseCatalogSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('statistics'),
    config: statisticsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('features'),
    config: featuresSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('testimonials'),
    config: testimonialsSectionSchema,
  }),
  z.object({ ...sectionInstanceBase, type: z.literal('faq'), config: faqSectionSchema }),
  z.object({ ...sectionInstanceBase, type: z.literal('cta'), config: ctaSectionSchema }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('instructors'),
    config: instructorsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('gallery'),
    config: gallerySectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('contact'),
    config: contactSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('pageHeader'),
    config: pageHeaderSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('courseCategories'),
    config: courseCategoriesSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('steps'),
    config: stepsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('featureSplit'),
    config: featureSplitSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('courseSpotlight'),
    config: courseSpotlightSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('logos'),
    config: logosSectionSchema,
  }),
  z.object({ ...sectionInstanceBase, type: z.literal('map'), config: mapSectionSchema }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('schedule'),
    config: scheduleSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('results'),
    config: resultsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('whatsappBar'),
    config: whatsappBarSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('video'),
    config: videoSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('pricing'),
    config: pricingSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('countdown'),
    config: countdownSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('interestForm'),
    config: interestFormSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('announcementBar'),
    config: announcementBarSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('comparison'),
    config: comparisonSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('timeline'),
    config: timelineSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('videoTestimonials'),
    config: videoTestimonialsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('downloads'),
    config: downloadsSectionSchema,
  }),
  z.object({
    ...sectionInstanceBase,
    type: z.literal('certificates'),
    config: certificatesSectionSchema,
  }),
]);

/** A full page's section composition — the exact `SectionInstance[]` shape `updatePage`'s `sections` field carries. Section `id`s must be unique within one page (the frontend's Section Tree/reorder model assumes this — a duplicate id would make reordering and per-section edits ambiguous). */
export const sectionInstanceArraySchema = z
  .array(sectionInstanceSchema)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((section, index) => {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'errors.website.duplicateSectionId',
          path: [index, 'id'],
        });
      }
      seen.add(section.id);
    });
  });

export type ValidatedSectionInstance = z.infer<typeof sectionInstanceSchema>;
