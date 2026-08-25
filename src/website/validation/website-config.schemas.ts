/**
 * Website configuration / page validation schemas — brand, SEO,
 * navigation, header, footer, and page-level fields.
 *
 * `websiteBrandSchema`/`globalSeoSchema`/`pageSeoSchema`/
 * `createWebsitePageSchema` are a field-for-field backend reproduction of
 * the real frontend's `website.schemas.ts`. `navigationItemSchema`/
 * `websiteHeaderSchema`/`websiteFooterSchema` have no dedicated Zod
 * counterpart in the frontend today (`WebsiteNavigationTab.tsx` edits
 * these fields through plain structured form controls, not a
 * `zodResolver`) — these are still validated here against the exact
 * TypeScript shape `WebsiteNavigationItem`/`WebsiteHeaderConfig`/
 * `WebsiteFooterConfig` (`website.types.ts`) define, because every
 * tenant-authored field reaching storage must be schema-validated
 * server-side regardless of whether the client happens to run a Zod
 * resolver on it (master plan §16's blanket injection-boundary rule) —
 * bounds not pinned by a frontend constant use the same `MAX_SHORT_TEXT`/
 * `MAX_SECTION_ITEMS`-style ceilings already established elsewhere in this
 * domain, not an invented stricter or looser rule.
 */
import { z } from 'zod';
import {
  CANONICAL_PATH_REGEX,
  HSL_TRIPLET_REGEX,
  MAX_CANONICAL_PATH_LENGTH,
  MAX_OG_DESCRIPTION_LENGTH,
  MAX_OG_TITLE_LENGTH,
  MAX_PAGE_SLUG_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MAX_SECTION_ITEMS,
  MAX_SEO_DESCRIPTION_LENGTH,
  MAX_SEO_TITLE_LENGTH,
  MAX_SHORT_TEXT,
  MAX_SITE_TITLE_LENGTH,
  MIN_PAGE_SLUG_LENGTH,
  PAGE_SLUG_REGEX,
  WEBSITE_THEME_KEYS,
} from '../constants/website.constants';
import { isSafeExternalUrl } from './url-safety.util';

export const websiteThemeKeySchema = z.enum(WEBSITE_THEME_KEYS);

export const createWebsitePageSchema = z.object({
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_PAGE_TITLE_LENGTH, 'validation:maxLength'),
  slug: z
    .string()
    .min(MIN_PAGE_SLUG_LENGTH, 'validation:minLength')
    .max(MAX_PAGE_SLUG_LENGTH, 'validation:maxLength')
    .regex(PAGE_SLUG_REGEX, 'validation:invalidSlug'),
});

const canonicalPathSchema = z
  .string()
  .max(MAX_CANONICAL_PATH_LENGTH, 'validation:maxLength')
  .regex(CANONICAL_PATH_REGEX, 'validation:invalidUrl')
  .optional()
  .or(z.literal(''));

export const pageSeoSchema = z.object({
  metaTitle: z.string().max(MAX_SEO_TITLE_LENGTH, 'validation:maxLength').optional(),
  metaDescription: z
    .string()
    .max(MAX_SEO_DESCRIPTION_LENGTH, 'validation:maxLength')
    .optional(),
  ogTitle: z.string().max(MAX_OG_TITLE_LENGTH, 'validation:maxLength').optional(),
  ogDescription: z
    .string()
    .max(MAX_OG_DESCRIPTION_LENGTH, 'validation:maxLength')
    .optional(),
  ogImage: z.string().optional(),
  canonicalPath: canonicalPathSchema,
  indexable: z.boolean().optional(),
});

export const globalSeoSchema = z.object({
  siteTitle: z.string().max(MAX_SITE_TITLE_LENGTH, 'validation:maxLength').optional(),
  metaTitle: z.string().max(MAX_SEO_TITLE_LENGTH, 'validation:maxLength').optional(),
  metaDescription: z
    .string()
    .max(MAX_SEO_DESCRIPTION_LENGTH, 'validation:maxLength')
    .optional(),
  ogImage: z.string().optional(),
  robotsIndexable: z.boolean().optional(),
  sitemapEnabled: z.boolean().optional(),
  canonicalBaseUrl: z
    .string()
    .max(MAX_CANONICAL_PATH_LENGTH, 'validation:maxLength')
    .optional(),
});

const hslColor = z.string().regex(HSL_TRIPLET_REGEX, 'validation:invalidColor');

/** The full, stored shape — every color required. Used to validate the RESULT of merging a partial PATCH onto the existing stored brand, never the raw incoming payload itself. */
export const websiteBrandSchema = z.object({
  darkLogo: z.string().optional(),
  primaryColor: hslColor,
  secondaryColor: hslColor,
  accentColor: hslColor,
});

/** The incoming PATCH shape — matches `Partial<WebsiteBrandConfig>` exactly; every field optional, each individually bound the same as the full schema. */
export const websiteBrandPatchSchema = z.object({
  darkLogo: z.string().optional(),
  primaryColor: hslColor.optional(),
  secondaryColor: hslColor.optional(),
  accentColor: hslColor.optional(),
});

const navigationItemSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  label: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  pageId: z.string().min(1, 'validation:required'),
  order: z.number().int(),
});

export const websiteNavigationSchema = z
  .array(navigationItemSchema)
  .max(MAX_SECTION_ITEMS);

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

export const websiteHeaderSchema = z.object({
  cta: websiteCtaSchema.optional(),
});

const footerLinkSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  label: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  pageId: z.string().optional(),
  url: z
    .string()
    .url('validation:invalidUrl')
    .refine(isSafeExternalUrl, { message: 'validation:invalidUrl' })
    .optional()
    .or(z.literal('')),
});

const footerGroupSchema = z.object({
  id: z.string().min(1, 'validation:required'),
  title: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_SHORT_TEXT, 'validation:maxLength'),
  links: z.array(footerLinkSchema).max(MAX_SECTION_ITEMS),
});

export const websiteFooterSchema = z.object({
  groups: z.array(footerGroupSchema).max(MAX_SECTION_ITEMS),
  socialLinks: z.array(footerLinkSchema).max(MAX_SECTION_ITEMS),
  copyrightText: z.string().max(MAX_SHORT_TEXT, 'validation:maxLength').optional(),
});
