/**
 * Image field values (Theme 1 plan §E.4 / §E.5) — mirrors the frontend's
 * `image-value.utils.ts` exactly.
 *
 * Allowed: empty; a theme asset reference (`theme-asset:<theme>/<key>`,
 * resolved to self-hosted, versioned files by the renderer); an http(s)
 * URL (a MediaAsset in the Academy's own storage); or a LEGACY inline
 * upload (`data:image/png|jpeg|webp;base64,…`, what the editor stored before
 * the media fix — accepted so an existing page can still be saved, never
 * produced by new uploads). Everything else is rejected, so a crafted
 * payload can't put a `javascript:` / `data:text/html` / `blob:` value into
 * an `<img src>` on a public site.
 */
import {
  LEGACY_DATA_IMAGE_PATTERN,
  THEME_ASSET_REFERENCE_PATTERN,
} from '../constants/website.constants';

export type ImageValueKind = 'empty' | 'themeAsset' | 'url' | 'legacyInline';

export function classifyImageValue(value: string): ImageValueKind | null {
  if (value === '') return 'empty';
  if (THEME_ASSET_REFERENCE_PATTERN.test(value)) return 'themeAsset';
  if (value.startsWith('data:')) {
    return LEGACY_DATA_IMAGE_PATTERN.test(value) ? 'legacyInline' : null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? 'url' : null;
  } catch {
    return null;
  }
}

export function isAllowedImageValue(value: string): boolean {
  return classifyImageValue(value) !== null;
}
