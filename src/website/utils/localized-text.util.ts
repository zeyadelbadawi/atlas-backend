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

function isLocalizedTextValue(value: object): value is LocalizedTextLike {
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof (value as Partial<LocalizedTextLike>).en === 'string' &&
    typeof (value as Partial<LocalizedTextLike>).ar === 'string'
  );
}

/**
 * B0-WEB-02 — what visitors read on an ARABIC-default site. There Arabic is
 * the required language and English optional, so a bilingual value may have
 * a blank English side; on the site's `/en` pages it shows its Arabic text
 * rather than nothing — the mirror of a blank Arabic side showing English on
 * every English-default site (`resolveLocalizedText`). Applied to the public
 * responses of Arabic-default sites only (never to an English-default site,
 * whose responses stay exactly as they were, and never to the dashboard's).
 * Every `{en, ar}` string pair at any depth is a `LocalizedText`.
 */
export function fillBlankEnglish<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => fillBlankEnglish(item)) as T;
  if (value === null || typeof value !== 'object') return value;
  if (isLocalizedTextValue(value)) {
    return (
      value.en.trim() === '' && value.ar.trim() !== ''
        ? { ...value, en: value.ar }
        : value
    ) as T;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, fillBlankEnglish(entry)]),
  ) as T;
}
