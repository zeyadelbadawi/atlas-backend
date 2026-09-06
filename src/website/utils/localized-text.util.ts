/**
 * Resolves a `LocalizedText` value for one locale — the backend's
 * counterpart to the frontend's identically-named `localized-text.utils.ts`
 * (`resolveLocalizedText`). English is the one required-complete language;
 * a blank/absent Arabic side degrades to it, never producing an empty
 * result. Also accepts a bare legacy string (pre-Phase-6 data that has not
 * round-tripped through `coerceLegacyLocalized` yet).
 */
import type { PublicWebsiteLocale } from '../constants/locale.constants';

export interface LocalizedTextLike {
  readonly en: string;
  readonly ar: string;
}

export function resolveLocalizedText(
  value: LocalizedTextLike | string | undefined,
  locale: PublicWebsiteLocale,
): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value[locale] || value.en;
}
