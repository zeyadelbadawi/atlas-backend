/**
 * CMS phase 4 — responsive image variants: smaller AVIF/WebP copies of a
 * public raster image, so a visitor's browser downloads the size its
 * layout needs (`srcset`) in a modern format instead of the full original.
 *
 * WHICH ASSETS. Public (`access = public`, provider `r2`) JPEG, PNG and
 * still WebP images only. GIF (animation), SVG (vector), animated WebP,
 * video and documents are left alone: resizing them would lose what they
 * are.
 *
 * WHICH SIZES. `IMAGE_VARIANT_WIDTHS` below the original's width, never an
 * upscale; and when the ladder stops short of the original (an original no
 * wider than the largest step), one more copy at the original's own width,
 * so every eligible image has at least one variant and the largest variant
 * is never smaller than necessary. A 4000px original gets 480, 960 and
 * 1600; a 1600px one 480, 960 and 1600; a 1000px one 480, 960 and 1000; a
 * 300px one 300.
 *
 * WHERE. Next to the original in the same bucket, at keys DERIVED from the
 * original's (`imageVariantKey`), so nothing but the list of widths and
 * formats needs storing (`media_assets.variants`). The derived name is not
 * a UUID, so the public route can never be asked for a variant key directly.
 *
 * COST. One decode per width (cloned into both encoders), libvips limited
 * to `VARIANT_SHARP_THREADS` threads and AVIF at a low encoder effort: a
 * small VPS spends seconds, not minutes, on a large photo, and the media
 * worker processes one job at a time.
 */
import sharp from 'sharp';

export const IMAGE_VARIANT_WIDTHS = [480, 960, 1600] as const;
export const IMAGE_VARIANT_FORMATS = ['avif', 'webp'] as const;
export type ImageVariantFormat = (typeof IMAGE_VARIANT_FORMATS)[number];

export const IMAGE_VARIANT_CONTENT_TYPES: Readonly<Record<ImageVariantFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
};

/** The source types variants are made from (by stored, magic-byte-sniffed MIME type). */
export const VARIANT_SOURCE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Refuse decompression bombs: 50 megapixels covers any real photo. */
const MAX_INPUT_PIXELS = 50_000_000;
const VARIANT_SHARP_THREADS = 2;
const AVIF_OPTIONS = { quality: 50, effort: 3 } as const;
const WEBP_OPTIONS = { quality: 75, effort: 4 } as const;

/** One stored variant, as recorded in `media_assets.variants`. */
export interface ImageVariant {
  readonly width: number;
  readonly height: number;
  readonly format: ImageVariantFormat;
  readonly sizeBytes: number;
}

export interface GeneratedImageVariant extends ImageVariant {
  readonly body: Buffer;
}

/** Whether an asset should have variants at all. */
export function isVariantEligible(asset: {
  readonly type: string;
  readonly access: string;
  readonly provider: string;
  readonly mimeType: string;
}): boolean {
  return (
    asset.type === 'image' &&
    asset.access === 'public' &&
    asset.provider === 'r2' &&
    VARIANT_SOURCE_MIME_TYPES.has(asset.mimeType.toLowerCase())
  );
}

/**
 * `academies/{a}/{uuid}.jpg` → `academies/{a}/variants/{uuid}/w480.avif`.
 * Deterministic, so regenerating overwrites rather than accumulates.
 */
export function imageVariantKey(
  storageKey: string,
  width: number,
  format: ImageVariantFormat,
): string {
  const slash = storageKey.lastIndexOf('/');
  const directory = slash >= 0 ? storageKey.slice(0, slash) : '';
  const fileName = storageKey.slice(slash + 1);
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${directory ? `${directory}/` : ''}variants/${stem}/w${width}.${format}`;
}

/** The widths to produce for an original `originalWidth` pixels wide (see the file comment). */
export function planVariantWidths(originalWidth: number): number[] {
  if (!Number.isInteger(originalWidth) || originalWidth < 1) return [];
  const widths: number[] = IMAGE_VARIANT_WIDTHS.filter((width) => width < originalWidth);
  const largest = IMAGE_VARIANT_WIDTHS[IMAGE_VARIANT_WIDTHS.length - 1];
  if (originalWidth <= largest) widths.push(originalWidth);
  return widths;
}

/**
 * Encodes every planned variant. Returns `[]` for an image that should not
 * get variants after all (animated, or no readable size). Throws only for
 * bytes sharp cannot decode, which the caller treats as best-effort.
 */
export async function generateImageVariants(
  bytes: Buffer,
): Promise<GeneratedImageVariant[]> {
  sharp.concurrency(VARIANT_SHARP_THREADS);
  const input = { limitInputPixels: MAX_INPUT_PIXELS };
  const metadata = await sharp(bytes, input).metadata();
  if ((metadata.pages ?? 1) > 1) return [];
  const width = metadata.autoOrient?.width ?? metadata.width;
  if (!width) return [];

  const variants: GeneratedImageVariant[] = [];
  for (const target of planVariantWidths(width)) {
    const resized = sharp(bytes, input)
      .autoOrient()
      .resize({ width: target, withoutEnlargement: true });
    for (const format of IMAGE_VARIANT_FORMATS) {
      const pipeline = resized.clone();
      const { data, info } = await (
        format === 'avif' ? pipeline.avif(AVIF_OPTIONS) : pipeline.webp(WEBP_OPTIONS)
      ).toBuffer({ resolveWithObject: true });
      variants.push({
        width: info.width,
        height: info.height,
        format,
        sizeBytes: data.byteLength,
        body: data,
      });
    }
  }
  return variants;
}

/** Reads `media_assets.variants` defensively: anything malformed is ignored, never served. */
export function parseImageVariants(value: unknown): ImageVariant[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ImageVariant =>
      typeof entry === 'object' &&
      entry !== null &&
      Number.isInteger((entry as ImageVariant).width) &&
      (entry as ImageVariant).width > 0 &&
      (IMAGE_VARIANT_FORMATS as readonly string[]).includes(
        (entry as ImageVariant).format,
      ),
  );
}

/**
 * The variant to serve for `?w=&f=`: the narrowest stored one at least
 * `requestedWidth` wide, else the widest there is. `null` when the asset
 * has no variant in that format (the caller serves the original).
 */
export function pickImageVariant(
  variants: readonly ImageVariant[],
  format: ImageVariantFormat,
  requestedWidth: number,
): ImageVariant | null {
  const candidates = variants
    .filter((variant) => variant.format === format)
    .sort((a, b) => a.width - b.width);
  if (candidates.length === 0) return null;
  return (
    candidates.find((variant) => variant.width >= requestedWidth) ??
    candidates[candidates.length - 1]
  );
}
