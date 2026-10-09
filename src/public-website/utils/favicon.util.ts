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
 * Accepted values: PNG or ICO bytes as a data URL, an uploaded Atlas
 * media image (`/api/v1/public/media/academies/<id>/<uuid>.png`), or an
 * http(s) URL. SVG is not accepted (it can carry script), nor any other
 * data type.
 *
 * W2 — WHAT IS SERVED IS NARROWER THAN WHAT IS STORED. The route used to
 * 302 to whatever http(s) URL was stored, with a one-year immutable cache:
 * an open redirect on every Academy's own host, pinned in browser and edge
 * caches. Now only Atlas-hosted favicons are served — inline bytes, or a
 * same-origin redirect to the Academy's OWN uploaded media (path-only
 * `Location`, so it can never leave the host it was asked on). An external
 * URL is still accepted on save (an existing value must not make the
 * branding form unsavable) but is never redirected to: the public site
 * simply keeps the platform icon.
 */
import { createHash } from 'node:crypto';

const FAVICON_DATA_URL =
  /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon));base64,([A-Za-z0-9+/]+={0,2})$/;

/** 1 MB of bytes as base64, plus the data-URL prefix. */
export const MAX_FAVICON_REFERENCE_LENGTH = 1_400_100;

/** An uploaded Atlas media image, as the media library stores its URL. PNG only: a favicon. */
const MEDIA_FAVICON_PATH =
  /^\/api\/v1\/public\/media\/academies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export type FaviconSource =
  | { readonly kind: 'inline'; readonly contentType: string; readonly bytes: Buffer }
  /** A same-origin path to the Academy's own uploaded image — redirected to, path only. */
  | { readonly kind: 'media'; readonly path: string };

type StoredFavicon =
  | FaviconSource
  | { readonly kind: 'media_other_academy' }
  | { readonly kind: 'external' };

function classifyFavicon(
  value: string | null | undefined,
  academyId: string | undefined,
): StoredFavicon | null {
  if (!value) return null;
  const inline = FAVICON_DATA_URL.exec(value);
  if (inline) {
    const bytes = Buffer.from(inline[2], 'base64');
    return bytes.length > 0 ? { kind: 'inline', contentType: inline[1], bytes } : null;
  }
  // A relative media path, or an absolute URL whose path is one (the host
  // is dropped — only the path is ever redirected to).
  let path: string | null = value.startsWith('/') ? value : null;
  if (!path) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      path = url.search || url.hash ? null : url.pathname;
      if (!path || !MEDIA_FAVICON_PATH.test(path)) return { kind: 'external' };
    } catch {
      return null;
    }
  }
  const media = MEDIA_FAVICON_PATH.exec(path);
  if (!media) return null;
  return academyId === undefined || media[1].toLowerCase() === academyId.toLowerCase()
    ? { kind: 'media', path }
    : { kind: 'media_other_academy' };
}

/**
 * What a stored favicon can be SERVED as for this Academy, or `null` for
 * none: inline bytes, or a redirect to this Academy's own uploaded image.
 * An external URL, or another Academy's media, is never served (W2).
 */
export function parseFavicon(
  value: string | null | undefined,
  academyId: string,
): FaviconSource | null {
  const stored = classifyFavicon(value, academyId);
  return stored && (stored.kind === 'inline' || stored.kind === 'media') ? stored : null;
}

/** Whether a value may be stored as an Academy favicon (empty clears it). */
export function isFaviconReference(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return (
    typeof value === 'string' &&
    value.length <= MAX_FAVICON_REFERENCE_LENGTH &&
    classifyFavicon(value, undefined) !== null
  );
}

/** A short, stable version of a stored favicon value: changes when it does. */
export function faviconVersion(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
