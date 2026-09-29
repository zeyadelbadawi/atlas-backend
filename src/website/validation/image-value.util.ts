/**
 * Image field values (Theme 1 plan §E.4 / §E.5) — mirrors the frontend's
 * `image-value.utils.ts` exactly.
 *
 * Allowed: empty; a theme asset reference (`theme-asset:<theme>/<key>`,
 * resolved to self-hosted, versioned files by the renderer); an Atlas
 * MediaAsset URL (relative `/api/v1/public/media/…`, what the media library
 * and uploads store); an absolute http(s) URL; or a LEGACY inline
 * upload (`data:image/png|jpeg|webp;base64,…`, what the editor stored before
 * the media fix — accepted so an existing page can still be saved, never
 * produced by new uploads). Everything else is rejected, so a crafted
 * payload can't put a `javascript:` / `data:text/html` / `blob:` value into
 * an `<img src>` on a public site.
 */
import {
  LEGACY_DATA_IMAGE_PATTERN,
  MEDIA_ASSET_PATH_PATTERN,
  THEME_ASSET_REFERENCE_PATTERN,
} from '../constants/website.constants';

export type ImageValueKind =
  'empty' | 'themeAsset' | 'mediaAsset' | 'url' | 'legacyInline';

export function classifyImageValue(value: string): ImageValueKind | null {
  if (value === '') return 'empty';
  if (THEME_ASSET_REFERENCE_PATTERN.test(value)) return 'themeAsset';
  if (MEDIA_ASSET_PATH_PATTERN.test(value)) return 'mediaAsset';
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
