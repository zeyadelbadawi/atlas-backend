/**
 * The images every Academy website has from the day it is published
 * (SEO/AEO/GEO pass, Nov 2026) — pure helpers for `BrandImagesService`.
 *
 *   - the share card (`og-image.png`, 1200×630): the Academy's name on its
 *     brand colour — the `og:image`/`twitter:image` of every page whose
 *     owner set none (a shared link used to show no picture at all);
 *   - the monogram (`icon.png?size=N`): the first letter of the name on the
 *     brand colour — the `apple-touch-icon`, and the favicon of an Academy
 *     that uploaded none (the platform's own icon used to stand for it).
 *
 * `brandImageVersion` is mirrored by the frontend
 * (`academy-brand-images.utils.ts`): the page links `?v=<version>`, and
 * the route lets exactly that URL be cached for a year.
 */

/** FNV-1a (32-bit) over UTF-16 code units of `name + "\0" + colour`, 8 hex digits. */
export function brandImageVersion(name: string, color: string | undefined): string {
  const input = `${name}\u0000${color ?? ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The sizes the monogram route draws (the favicon's 96 is a multiple of 48, as Google asks). */
export const MONOGRAM_SIZES = [48, 96, 180, 192, 512] as const;
export type MonogramSize = (typeof MONOGRAM_SIZES)[number];

export function parseMonogramSize(value: string | undefined): MonogramSize | null {
  const size = Number(value ?? 180);
  return (MONOGRAM_SIZES as readonly number[]).includes(size)
    ? (size as MonogramSize)
    : null;
}

/** The colour a new Academy's brand starts with (`DEFAULT_BRAND_COLOR`). */
const FALLBACK_COLOR = { r: 37, g: 99, b: 235 };

/** `"H S% L%"` (the stored brand triplet) → RGB; the default blue when malformed. */
export function hslTripletToRgb(value: string | undefined): {
  r: number;
  g: number;
  b: number;
} {
  const match = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*$/.exec(
    value ?? '',
  );
  if (!match) return FALLBACK_COLOR;
  const h = (Number(match[1]) % 360) / 360;
  const s = Math.min(100, Number(match[2])) / 100;
  const l = Math.min(100, Number(match[3])) / 100;
  if (s === 0) {
    const grey = Math.round(l * 255);
    return { r: grey, g: grey, b: grey };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** White or near-black, whichever reads better on `background` (WCAG contrast). */
export function textColorOn(background: { r: number; g: number; b: number }): string {
  const bg = luminance(background);
  const onWhite = 1.05 / (bg + 0.05);
  const onDark = (bg + 0.05) / (luminance({ r: 17, g: 24, b: 39 }) + 0.05);
  return onWhite >= onDark ? '#ffffff' : '#111827';
}

export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Pango markup text: `&`, `<`, `>`, quotes escaped. */
export function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The name as drawn: control characters dropped, whitespace collapsed, at most 90 characters. */
export function displayName(name: string): string {
  const clean = name
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // By code point, so an emoji or other astral character is never split.
  const characters = [...clean];
  return characters.length > 90
    ? `${characters.slice(0, 89).join('')}…`
    : clean || 'Academy';
}

/** The monogram's letter: the name's first letter or digit (a whole grapheme, Arabic included), upper-cased. */
export function monogramLetter(name: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment } of segmenter.segment(name)) {
    if (/[\p{L}\p{N}]/u.test(segment)) return segment.toLocaleUpperCase();
  }
  return 'A';
}

/** The card's type size: long names get a smaller face so they fit in at most three lines. */
export function cardFontSize(name: string): number {
  const length = [...name].length;
  if (length <= 18) return 96;
  if (length <= 34) return 80;
  if (length <= 60) return 64;
  return 52;
}
