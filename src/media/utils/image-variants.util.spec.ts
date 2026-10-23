/**
 * CMS phase 4 — the variant plan (widths, keys, selection) and real
 * encoding through sharp on synthesized images.
 */
import sharp from 'sharp';
import {
  generateImageVariants,
  imageVariantKey,
  isVariantEligible,
  parseImageVariants,
  pickImageVariant,
  planVariantWidths,
  type ImageVariant,
} from './image-variants.util';

function image(width: number, height: number, format: 'jpeg' | 'png'): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 20 } },
  })
    [format]()
    .toBuffer();
}

describe('planVariantWidths', () => {
  it('never upscales, and tops a short ladder off with the original width', () => {
    expect(planVariantWidths(4000)).toEqual([480, 960, 1600]);
    expect(planVariantWidths(1600)).toEqual([480, 960, 1600]);
    expect(planVariantWidths(1000)).toEqual([480, 960, 1000]);
    expect(planVariantWidths(480)).toEqual([480]);
    expect(planVariantWidths(300)).toEqual([300]);
  });

  it('plans nothing for an unreadable width', () => {
    expect(planVariantWidths(0)).toEqual([]);
    expect(planVariantWidths(Number.NaN)).toEqual([]);
  });
});

describe('imageVariantKey', () => {
  it('derives a deterministic key beside the original that is not a servable file name', () => {
    expect(imageVariantKey('academies/a1/f00d.jpg', 480, 'avif')).toBe(
      'academies/a1/variants/f00d/w480.avif',
    );
    expect(imageVariantKey('academies/a1/f00d.png', 1600, 'webp')).toBe(
      'academies/a1/variants/f00d/w1600.webp',
    );
  });
});

describe('isVariantEligible', () => {
  const base = {
    type: 'image',
    access: 'public',
    provider: 'r2',
    mimeType: 'image/jpeg',
  };

  it('takes public JPEG, PNG and WebP images only', () => {
    expect(isVariantEligible(base)).toBe(true);
    expect(isVariantEligible({ ...base, mimeType: 'image/png' })).toBe(true);
    expect(isVariantEligible({ ...base, mimeType: 'image/webp' })).toBe(true);
    expect(isVariantEligible({ ...base, mimeType: 'image/gif' })).toBe(false);
    expect(isVariantEligible({ ...base, mimeType: 'image/svg+xml' })).toBe(false);
    expect(
      isVariantEligible({ ...base, type: 'document', mimeType: 'application/pdf' }),
    ).toBe(false);
    expect(isVariantEligible({ ...base, access: 'protected' })).toBe(false);
    expect(isVariantEligible({ ...base, provider: 'cloudflare_stream' })).toBe(false);
  });
});

describe('pickImageVariant', () => {
  const variants: ImageVariant[] = [480, 960, 1000].flatMap((width) =>
    (['avif', 'webp'] as const).map((format) => ({
      width,
      height: width / 2,
      format,
      sizeBytes: 1,
    })),
  );

  it('picks the narrowest variant at least as wide as asked, else the widest', () => {
    expect(pickImageVariant(variants, 'avif', 1)?.width).toBe(480);
    expect(pickImageVariant(variants, 'avif', 480)?.width).toBe(480);
    expect(pickImageVariant(variants, 'webp', 481)?.width).toBe(960);
    expect(pickImageVariant(variants, 'webp', 1600)?.width).toBe(1000);
    expect(pickImageVariant(variants, 'webp', 1600)?.format).toBe('webp');
  });

  it('has nothing to pick without variants of that format', () => {
    expect(pickImageVariant([], 'avif', 480)).toBeNull();
    expect(
      pickImageVariant(
        variants.filter((variant) => variant.format === 'webp'),
        'avif',
        480,
      ),
    ).toBeNull();
  });
});

describe('parseImageVariants', () => {
  it('keeps well-formed entries and drops anything else', () => {
    expect(parseImageVariants(null)).toEqual([]);
    expect(parseImageVariants({})).toEqual([]);
    expect(
      parseImageVariants([
        { width: 480, height: 240, format: 'avif', sizeBytes: 10 },
        { width: -1, format: 'avif' },
        { width: 480, format: 'png' },
        'nope',
      ]),
    ).toEqual([{ width: 480, height: 240, format: 'avif', sizeBytes: 10 }]);
  });
});

describe('generateImageVariants', () => {
  it('encodes AVIF and WebP at every planned width, keeping the aspect ratio', async () => {
    const variants = await generateImageVariants(await image(1200, 600, 'jpeg'));
    expect(variants.map((variant) => [variant.width, variant.format])).toEqual([
      [480, 'avif'],
      [480, 'webp'],
      [960, 'avif'],
      [960, 'webp'],
      [1200, 'avif'],
      [1200, 'webp'],
    ]);
    for (const variant of variants) {
      expect(variant.height).toBe(variant.width / 2);
      expect(variant.sizeBytes).toBe(variant.body.byteLength);
      const metadata = await sharp(variant.body).metadata();
      expect(metadata.width).toBe(variant.width);
      expect(metadata.format).toBe(variant.format === 'avif' ? 'heif' : 'webp');
    }
  }, 30000);

  it('makes one full-size pair for an image narrower than the smallest step', async () => {
    const variants = await generateImageVariants(await image(200, 100, 'png'));
    expect(variants.map((variant) => [variant.width, variant.format])).toEqual([
      [200, 'avif'],
      [200, 'webp'],
    ]);
  });

  it('makes nothing for an animated image', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 20, height: 10, channels: 3, background } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#fff'), await frame('#000')], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(generateImageVariants(animated)).resolves.toEqual([]);
  });

  it('throws for bytes that are not an image', async () => {
    await expect(generateImageVariants(Buffer.from('not an image'))).rejects.toThrow();
  });
});
