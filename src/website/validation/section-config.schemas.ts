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
 * needed or performed — see `website-page.contract.ts`/
 * `website-configuration.contract.ts`, which run every stored row through
 * this same schema on the way OUT (not just on the way in) so a
 * never-re-saved legacy Academy is normalized to the new shape the moment
 * it's next read, not only the moment it's next edited.
 */
import { z } from 'zod';
import {
  FEATURE_ICON_OPTIONS,
  MAX_LONG_TEXT,
  MAX_SECTION_ITEMS,
  MAX_SHORT_TEXT,
  SECTION_TYPES,
} from '../constants/website.constants';
import { isSafeExternalUrl } from './url-safety.util';

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

/** `en` is required non-empty (the one always-complete language); `ar` may be empty or absent — an incomplete translation degrades to `en` at render time, it never blocks a save. */
export const localizedRequired = (maxLength: number) =>
  z.preprocess(
    coerceLegacyLocalized,
    z.object({
      en: z.string().min(1, 'validation:required').max(maxLength, 'validation:maxLength'),
      ar: optionalArabic(maxLength),
    }),
  );

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

/** `url` is checked against `isSafeExternalUrl` in addition to being syntactically a URL — matches the frontend's `websiteCtaSchema` exactly. */
const websiteCtaSchema = z.object({
  label: localizedRequired(MAX_SHORT_TEXT),
  pageId: z.string().optional(),
  courseId: z.string().optional(),
  url: z
    .string()
    .url('validation:invalidUrl')
    .refine(isSafeExternalUrl, { message: 'validation:invalidUrl' })
    .optional()
    .or(z.literal('')),
});

export const heroSectionSchema = z.object({
  eyebrow: localizedOptional(MAX_SHORT_TEXT).optional(),
  title: localizedRequired(MAX_SHORT_TEXT),
  subtitle: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  image: z.string().optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
});

export const aboutSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  body: localizedRequired(MAX_LONG_TEXT),
  image: z.string().optional(),
  imageAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
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

const statisticItemSchema = z.object({
  id: z.string(),
  /** Deliberately localized, not just numeral-formatted: an Owner may want distinct copy per language (e.g. "500+" vs "٥٠٠+", or a differently-worded suffix), not a locale-conversion of one authored value. */
  value: localizedRequired(20),
  label: localizedRequired(MAX_SHORT_TEXT),
  /** Present only when generated (§1.4/§6.2 of the specification) — resolves a real, live, Academy-scoped count instead of the static `value` above. Absent means "use the authored `value` as-is," matching today's manually-authored behavior exactly. */
  metric: z.enum(['courses', 'students', 'instructors']).optional(),
});

export const statisticsSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
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
  avatar: z.string().optional(),
  avatarAlt: localizedOptional(MAX_SHORT_TEXT).optional(),
});

export const testimonialsSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  items: z.array(testimonialItemSchema).max(MAX_SECTION_ITEMS),
  // `libraryEntryIds` references the Prompt 10 CMS content library, which
  // does not exist yet in this phase — accepted structurally (matching the
  // frontend's own optional `string[]` field) but never resolved against
  // anything, since there is nothing to resolve against until P10.
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
});

export const ctaSectionSchema = z.object({
  title: localizedRequired(MAX_SHORT_TEXT),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  cta: websiteCtaSchema,
});

export const instructorsSectionSchema = z.object({
  title: localizedOptional(MAX_SHORT_TEXT).optional(),
  description: localizedOptional(MAX_LONG_TEXT).optional(),
  count: z.number().int().min(1).max(MAX_SECTION_ITEMS),
});

const galleryImageSchema = z.object({
  id: z.string(),
  image: z.string().min(1, 'validation:required'),
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

/** Matches the frontend's `SECTION_SCHEMAS` map exactly — one schema per `SectionType`, `satisfies Record<SectionType, ZodTypeAny>`. */
const SECTION_CONFIG_SCHEMAS = {
  hero: heroSectionSchema,
  about: aboutSectionSchema,
  featuredCourses: featuredCoursesSectionSchema,
  statistics: statisticsSectionSchema,
  features: featuresSectionSchema,
  testimonials: testimonialsSectionSchema,
  faq: faqSectionSchema,
  cta: ctaSectionSchema,
  instructors: instructorsSectionSchema,
  gallery: gallerySectionSchema,
  contact: contactSectionSchema,
} satisfies Record<(typeof SECTION_TYPES)[number], z.ZodTypeAny>;

/** Resolves the right Zod schema for a section type — matches `getSectionConfigSchema`. */
export function getSectionConfigSchema(
  type: (typeof SECTION_TYPES)[number],
): z.ZodTypeAny {
  return SECTION_CONFIG_SCHEMAS[type];
}

/** One base fields shape (`id`/`enabled`/`visibility`) shared by every section instance branch below — factored out so each branch below is a one-liner, never eleven hand-copied field lists. */
const sectionInstanceBase = {
  id: z.string().min(1, 'validation:required'),
  enabled: z.boolean(),
  visibility: responsiveVisibilitySchema,
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
