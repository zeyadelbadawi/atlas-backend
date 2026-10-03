/**
 * W3 — the email-safe academy logo (investigation W3b §A.6).
 *
 * WHY. An email `<img>` must be an ABSOLUTE https URL that every client can
 * fetch and render. The stored `academies.logo_url` is none of those
 * reliably: a relative MediaAsset path, a remote URL of unknown type, or a
 * legacy inline `data:image/...;base64` URI that Gmail, Outlook and Yahoo
 * refuse to render (and that pushes the HTML toward Gmail's clipping limit).
 *
 * THE RULE. Only two stored shapes are usable, and both are read from
 * Atlas's OWN public storage or the row itself — never fetched from a
 * third-party URL (no SSRF, no tracking pixel by proxy):
 *   - the academy's own public MediaAsset path
 *     (`/api/v1/public/media/academies/<thisAcademyId>/<uuid>.<png|jpg|jpeg|gif|webp>`,
 *     relative or absolute on any host — the KEY is what is read);
 *   - an inline `data:image/(png|jpeg|jpg|gif|webp);base64,...` URI.
 * Anything else (a remote http(s) URL, SVG, another academy's asset, junk)
 * is "no usable logo": the email shows the academy name as text instead.
 *
 * Usable bytes are always re-encoded to a bounded PNG
 * (`EmailLogoService`), so the public route only ever serves PNG — never
 * WebP/GIF that Outlook desktop cannot show, never metadata, never a
 * decompression bomb at full size.
 */
import { createHash } from 'node:crypto';

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const MEDIA_PATH = new RegExp(
  `^/api/v1/public/media/academies/(${UUID})/(${UUID})\\.(png|jpe?g|gif|webp)$`,
  'i',
);
const DATA_URI = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Raw input bytes larger than this are refused before decoding. */
export const EMAIL_LOGO_MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** The rendered size in the email: 40px tall, at most 200px wide. */
export const EMAIL_LOGO_DISPLAY_HEIGHT = 40;
export const EMAIL_LOGO_MAX_DISPLAY_WIDTH = 200;

export type EmailLogoSource =
  | { readonly kind: 'media'; readonly storageKey: string }
  | { readonly kind: 'inline'; readonly bytes: Buffer };

/** Where a stored logo value can be read from, or `null` when it is unusable in email. */
export function parseEmailLogoSource(
  logoUrl: string | null | undefined,
  academyId: string,
): EmailLogoSource | null {
  if (typeof logoUrl !== 'string' || logoUrl.length === 0) return null;
  const inline = DATA_URI.exec(logoUrl);
  if (inline) {
    // Cheap pre-check on the encoded length before allocating the buffer.
    if ((inline[2].length * 3) / 4 > EMAIL_LOGO_MAX_SOURCE_BYTES) return null;
    const bytes = Buffer.from(inline[2], 'base64');
    return bytes.length > 0 ? { kind: 'inline', bytes } : null;
  }
  let path = logoUrl;
  if (/^https?:\/\//i.test(logoUrl)) {
    try {
      path = new URL(logoUrl).pathname;
    } catch {
      return null;
    }
  }
  const media = MEDIA_PATH.exec(path);
  if (!media) return null;
  // Only this academy's own asset: a logo value pointing into another
  // tenant's prefix is not served under this academy's name.
  if (media[1].toLowerCase() !== academyId.toLowerCase()) return null;
  return {
    kind: 'media',
    storageKey: `academies/${media[1]}/${media[2]}.${media[3]}`,
  };
}

/** Short, stable version of a stored logo value: a new value is a new URL. */
export function emailLogoVersion(logoUrl: string): string {
  return createHash('sha256').update(logoUrl).digest('hex').slice(0, 16);
}

/** `width`/`height` attributes for a `w`×`h` image shown 40px tall, capped at 200px wide. */
export function emailLogoDisplaySize(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  if (!(width > 0) || !(height > 0)) {
    return { width: EMAIL_LOGO_DISPLAY_HEIGHT, height: EMAIL_LOGO_DISPLAY_HEIGHT };
  }
  const scaledWidth = Math.max(
    1,
    Math.round((EMAIL_LOGO_DISPLAY_HEIGHT * width) / height),
  );
  if (scaledWidth <= EMAIL_LOGO_MAX_DISPLAY_WIDTH) {
    return { width: scaledWidth, height: EMAIL_LOGO_DISPLAY_HEIGHT };
  }
  return {
    width: EMAIL_LOGO_MAX_DISPLAY_WIDTH,
    height: Math.max(1, Math.round((EMAIL_LOGO_MAX_DISPLAY_WIDTH * height) / width)),
  };
}
