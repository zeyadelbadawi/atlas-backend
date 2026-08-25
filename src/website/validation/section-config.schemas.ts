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

/** `url` is checked against `isSafeExternalUrl` in addition to being syntactically a URL — matches the frontend's `websiteCtaSchema` exactly. */
const websiteCtaSchema = z.object({
  label: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
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
  eyebrow: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  subtitle: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
  image: z.string().optional(),
  imageAlt: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  cta: websiteCtaSchema.optional(),
  secondaryCta: websiteCtaSchema.optional(),
});

export const aboutSectionSchema = z.object({
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  body: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_LONG_TEXT, 'validation:maxLength'),
  image: z.string().optional(),
  imageAlt: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
});

export const featuredCoursesSectionSchema = z.object({
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
  mode: z.enum(['latest', 'selected']),
  courseIds: z.array(z.string()).optional(),
  layout: z.enum(['grid', 'carousel']),
  count: z.number().int().min(1).max(MAX_SECTION_ITEMS),
  showPrice: z.boolean(),
  showInstructor: z.boolean(),
});

const statisticItemSchema = z.object({
  id: z.string(),
  value: z.string().min(1, 'validation:required').max(20, 'validation:maxLength'),
  label: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
});

export const statisticsSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  items: z.array(statisticItemSchema).max(MAX_SECTION_ITEMS),
});

const featureItemSchema = z.object({
  id: z.string(),
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength'),
  icon: z.enum(FEATURE_ICON_OPTIONS as [string, ...string[]]),
});

export const featuresSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
  items: z.array(featureItemSchema).max(MAX_SECTION_ITEMS),
});

const testimonialItemSchema = z.object({
  id: z.string(),
  quote: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_LONG_TEXT, 'validation:maxLength'),
  authorName: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  authorRole: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  avatar: z.string().optional(),
  avatarAlt: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
});

export const testimonialsSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  items: z.array(testimonialItemSchema).max(MAX_SECTION_ITEMS),
  // `libraryEntryIds` references the Prompt 10 CMS content library, which
  // does not exist yet in this phase — accepted structurally (matching the
  // frontend's own optional `string[]` field) but never resolved against
  // anything, since there is nothing to resolve against until P10.
  libraryEntryIds: z.array(z.string()).max(MAX_SECTION_ITEMS).optional(),
});

const faqItemSchema = z.object({
  id: z.string(),
  question: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  answer: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_LONG_TEXT, 'validation:maxLength'),
});

export const faqSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  items: z.array(faqItemSchema).max(MAX_SECTION_ITEMS),
  libraryEntryIds: z.array(z.string()).max(MAX_SECTION_ITEMS).optional(),
});

export const ctaSectionSchema = z.object({
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
  cta: websiteCtaSchema,
});

export const instructorsSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
  count: z.number().int().min(1).max(MAX_SECTION_ITEMS),
});

const galleryImageSchema = z.object({
  id: z.string(),
  image: z.string().min(1, 'validation:required'),
  caption: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  imageAlt: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
});

export const gallerySectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  images: z.array(galleryImageSchema).max(MAX_SECTION_ITEMS),
});

export const contactSectionSchema = z.object({
  title: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
  description: z.string().max(MAX_LONG_TEXT, 'validation:maxLength').optional(),
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
