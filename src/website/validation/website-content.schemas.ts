/**
 * Website CMS content validation schemas — FAQ and Testimonial library
 * entries (master plan §21 Phase P10). A field-for-field backend
 * reproduction of the real frontend's `website-content.schemas.ts`.
 *
 * `status` is deliberately absent from every schema here — the real
 * `UpdateWebsiteFaqEntryPayload`/`UpdateWebsiteTestimonialEntryPayload`
 * types have no `status` field at all; the only way to change status is
 * the dedicated `publish`/`archive` actions (`WebsiteContentService`,
 * frontend), never an implicit side effect of a generic field edit.
 */
import { z } from 'zod';
import {
  MAX_FAQ_ANSWER_LENGTH,
  MAX_FAQ_QUESTION_LENGTH,
  MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH,
  MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH,
  MAX_TESTIMONIAL_QUOTE_LENGTH,
} from '../constants/website.constants';

/** Both English and Arabic values are required — an entry that only exists in one language would silently disappear when a visitor's locale doesn't match it. Matches the frontend's `localizedText` helper exactly. */
const localizedText = (maxLength: number) =>
  z.object({
    en: z.string().min(1, 'validation:required').max(maxLength, 'validation:maxLength'),
    ar: z.string().min(1, 'validation:required').max(maxLength, 'validation:maxLength'),
  });

/** Both keys must be present, but content may be empty — matches the frontend's `localizedTextOptional` helper exactly (used only for `authorRole`, itself an optional field as a whole). */
const localizedTextOptional = (maxLength: number) =>
  z.object({
    en: z.string().max(maxLength, 'validation:maxLength'),
    ar: z.string().max(maxLength, 'validation:maxLength'),
  });

export const createFaqEntrySchema = z.object({
  question: localizedText(MAX_FAQ_QUESTION_LENGTH),
  answer: localizedText(MAX_FAQ_ANSWER_LENGTH),
});

export const updateFaqEntrySchema = z.object({
  question: localizedText(MAX_FAQ_QUESTION_LENGTH).optional(),
  answer: localizedText(MAX_FAQ_ANSWER_LENGTH).optional(),
  order: z.number().int().optional(),
  visible: z.boolean().optional(),
});

export const createTestimonialEntrySchema = z.object({
  quote: localizedText(MAX_TESTIMONIAL_QUOTE_LENGTH),
  authorName: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH, 'validation:maxLength'),
  authorRole: localizedTextOptional(MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH).optional(),
  avatar: z.string().optional(),
});

export const updateTestimonialEntrySchema = z.object({
  quote: localizedText(MAX_TESTIMONIAL_QUOTE_LENGTH).optional(),
  authorName: z
    .string()
    .min(1, 'validation:required')
    .max(MAX_TESTIMONIAL_AUTHOR_NAME_LENGTH, 'validation:maxLength')
    .optional(),
  authorRole: localizedTextOptional(MAX_TESTIMONIAL_AUTHOR_ROLE_LENGTH).optional(),
  avatar: z.string().optional(),
  order: z.number().int().optional(),
  visible: z.boolean().optional(),
});
