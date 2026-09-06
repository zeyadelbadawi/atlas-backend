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
