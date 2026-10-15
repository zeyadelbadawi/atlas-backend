/**
 * Public Website Locale (Phase 6 — Bilingual Academy Websites).
 *
 * Mirrors the frontend's identically-named `locale.constants.ts` exactly —
 * see that file's own doc comment for why this is deliberately a SEPARATE
 * constant from anything dashboard-chrome-related, not a shared list.
 */

export const PUBLIC_WEBSITE_LOCALES = ['en', 'ar'] as const;

export type PublicWebsiteLocale = (typeof PUBLIC_WEBSITE_LOCALES)[number];

export const DEFAULT_PUBLIC_WEBSITE_LOCALE: PublicWebsiteLocale = 'en';

export function isPublicWebsiteLocale(value: string): value is PublicWebsiteLocale {
  return (PUBLIC_WEBSITE_LOCALES as readonly string[]).includes(value);
}

/**
 * B0-WEB-02 — a website's own default locale: the language served at `/`.
 * Every other supported locale lives under its own `/<locale>` prefix. Until
 * this, the default was fixed at `en`, which is still what a site gets
 * unless its owner chooses `ar` (`website_configurations.default_locale`).
 */
export function resolveDefaultLocale(value: unknown): PublicWebsiteLocale {
  return typeof value === 'string' && isPublicWebsiteLocale(value)
    ? value
    : DEFAULT_PUBLIC_WEBSITE_LOCALE;
}

/**
 * The URL prefix of `locale` on a site whose default is `defaultLocale`:
 * `''` for the default, `/<locale>` otherwise. With the default `en` this is
 * exactly the fixed rule every site had before (`''` / `/ar`).
 */
export function localePathPrefix(
  locale: PublicWebsiteLocale,
  defaultLocale: PublicWebsiteLocale = DEFAULT_PUBLIC_WEBSITE_LOCALE,
): string {
  return locale === defaultLocale ? '' : `/${locale}`;
}
