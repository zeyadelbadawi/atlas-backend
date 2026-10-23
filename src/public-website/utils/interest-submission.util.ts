/**
 * CMS phase 3d (batch C) — what a "register your interest" submission may
 * store, decided by the PUBLISHED `interestForm` section it names, never by
 * the client.
 *
 * The DTO has already checked each field's shape (a real email, a mobile
 * number for its country, lengths). This decides what the section asks
 * for:
 *   - email / message: hidden → dropped (a page cached before the Owner
 *     hid a field may still send it); required → must be sent;
 *   - the choice: a list with no options counts as hidden; when shown, a
 *     sent id must be one of the section's options, and a required one must
 *     be sent;
 *   - the name must hold more than spaces.
 * The chosen option is stored as its label in the visitor's language, and
 * the list's label beside it, so the Owner reads what the visitor saw even
 * after the options change.
 */
import { BadRequestException } from '@nestjs/common';
import type { FieldViolation } from '../../common/dto/api-error.dto';
import type { PublicWebsiteLocale } from '../../website/constants/locale.constants';

type FieldMode = 'hidden' | 'optional' | 'required';

interface LocalizedLike {
  readonly en?: string;
  readonly ar?: string;
}

/** The parts of a stored `interestForm` config this reads (stored JSON, so every key is checked). */
export interface InterestFormConfigLike {
  readonly emailField?: unknown;
  readonly choiceField?: unknown;
  readonly messageField?: unknown;
  readonly choiceLabel?: unknown;
  readonly options?: unknown;
}

interface SectionLike {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly enabled?: unknown;
  readonly config?: unknown;
}

export interface InterestSubmissionInput {
  readonly name: string;
  readonly email?: string;
  readonly message?: string;
  readonly choice?: string;
  readonly locale?: PublicWebsiteLocale;
}

export interface ResolvedInterestSubmission {
  readonly name: string;
  /** `''` when not asked for or not given — the column is NOT NULL. */
  readonly email: string;
  readonly message: string;
  readonly choice: string | null;
  readonly choiceLabel: string | null;
}

/** Column widths (`contact_submissions.choice` / `choice_label`). */
const CHOICE_MAX = 80;
const CHOICE_LABEL_MAX = 60;

function mode(value: unknown): FieldMode {
  return value === 'optional' || value === 'required' ? value : 'hidden';
}

function localized(value: unknown, locale: PublicWebsiteLocale): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const text = value as LocalizedLike;
  return (text[locale] || text.en || text.ar || '').trim();
}

interface InterestOption {
  readonly id: string;
  readonly label: unknown;
}

function optionsOf(config: InterestFormConfigLike): InterestOption[] {
  if (!Array.isArray(config.options)) return [];
  return config.options.filter(
    (option): option is InterestOption =>
      !!option &&
      typeof option === 'object' &&
      typeof (option as { id?: unknown }).id === 'string',
  );
}

/**
 * The enabled `interestForm` section with this id on any published page —
 * `undefined` when there is none (removed, disabled or never published).
 */
export function findPublishedInterestForm(
  pages: readonly { readonly sections?: readonly unknown[] }[],
  sectionId: string,
): InterestFormConfigLike | undefined {
  for (const page of pages) {
    for (const raw of page.sections ?? []) {
      const section = raw as SectionLike;
      if (
        section?.id === sectionId &&
        section.type === 'interestForm' &&
        section.enabled !== false &&
        section.config &&
        typeof section.config === 'object'
      ) {
        return section.config as InterestFormConfigLike;
      }
    }
  }
  return undefined;
}

/** Throws the global ValidationPipe's 400 shape when the submission does not fit the section. */
export function resolveInterestSubmission(
  config: InterestFormConfigLike,
  input: InterestSubmissionInput,
  fallbackLocale: PublicWebsiteLocale,
): ResolvedInterestSubmission {
  const locale = input.locale ?? fallbackLocale;
  const violations: FieldViolation[] = [];
  const name = input.name.trim();
  if (!name) violations.push({ field: 'name', messageKey: 'validation:required' });

  const take = (field: 'email' | 'message', fieldMode: FieldMode): string => {
    const value = (input[field] ?? '').trim();
    if (fieldMode === 'hidden') return '';
    if (fieldMode === 'required' && !value) {
      violations.push({ field, messageKey: 'validation:required' });
    }
    return value;
  };
  const email = take('email', mode(config.emailField));
  const message = take('message', mode(config.messageField));

  const options = optionsOf(config);
  const choiceMode = options.length > 0 ? mode(config.choiceField) : 'hidden';
  let choice: string | null = null;
  let choiceLabel: string | null = null;
  if (choiceMode !== 'hidden') {
    const picked = input.choice
      ? options.find((option) => option.id === input.choice)
      : undefined;
    if (input.choice && !picked) {
      violations.push({ field: 'choice', messageKey: 'validation:invalidChoice' });
    } else if (!picked && choiceMode === 'required') {
      violations.push({ field: 'choice', messageKey: 'validation:required' });
    } else if (picked) {
      choice = localized(picked.label, locale).slice(0, CHOICE_MAX) || null;
      choiceLabel =
        localized(config.choiceLabel, locale).slice(0, CHOICE_LABEL_MAX) || null;
    }
  }

  if (violations.length > 0) {
    throw new BadRequestException({
      messageKey: 'errors.validation.failed',
      violations,
    });
  }
  return { name, email, message, choice, choiceLabel };
}
