/**
 * The Academy favicon (2 Oct 2026).
 *
 * The branding form stores the uploaded favicon in `academies.favicon_url`
 * as a base64 data URL (`.ico` is not a media-asset type), up to 1 MB. The
 * public website never used it: every Academy site showed the platform's
 * own `/favicon.svg`. Inlining a data URL of that size into every page's
 * head (and the SSR HTML budget) is not an option, so the public site
 * links `GET public/websites/:academyId/favicon?v=<version>` instead:
 * the version is a hash of the stored value, so a new upload is a new
 * URL (browsers' favicon caches included) and an unchanged one can be
 * cached for a year.
 *
 * Accepted values: PNG or ICO bytes as a data URL, or an http(s) URL. SVG
 * is not accepted (it can carry script), nor any other data type.
 */
import { createHash } from 'node:crypto';

const FAVICON_DATA_URL =
  /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]+={0,2})$/;

/** 1 MB of bytes as base64, plus the data-URL prefix. */
export const MAX_FAVICON_REFERENCE_LENGTH = 1_400_100;

export type FaviconSource =
  | { readonly kind: 'inline'; readonly contentType: string; readonly bytes: Buffer }
  | { readonly kind: 'remote'; readonly url: string };

/** What a stored favicon value can be served as, or `null` for none/unusable. */
export function parseFavicon(value: string | null | undefined): FaviconSource | null {
  if (!value) return null;
  const inline = FAVICON_DATA_URL.exec(value);
  if (inline) {
    const bytes = Buffer.from(inline[2], 'base64');
    return bytes.length > 0 ? { kind: 'inline', contentType: inline[1], bytes } : null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? { kind: 'remote', url: url.toString() }
      : null;
  } catch {
    return null;
  }
}

/** Whether a value may be stored as an Academy favicon (empty clears it). */
export function isFaviconReference(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return (
    typeof value === 'string' &&
    value.length <= MAX_FAVICON_REFERENCE_LENGTH &&
    parseFavicon(value) !== null
  );
}

/** A short, stable version of a stored favicon value: changes when it does. */
export function faviconVersion(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
