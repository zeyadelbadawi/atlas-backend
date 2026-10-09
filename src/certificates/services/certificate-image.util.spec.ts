import sharp from 'sharp';
import {
  normalizeCertificateImage,
  sniffCertificateImageFormat,
} from './certificate-image.util';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function solid(
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff',
  width = 8,
  height = 8,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .toFormat(format)
    .toBuffer();
}

describe('normalizeCertificateImage (W4)', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'accepts %s and re-encodes it as PNG',
    async (f) => {
      const out = await normalizeCertificateImage(await solid(f));
      expect(out.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    },
  );

  // Every decoder outside the allowlist is where sharp's libvips/libheif/
  // librsvg advisories live; none of them may be reached. These all used
  // to decode (the renderer called sharp on whatever the URL returned).
  it('refuses GIF, TIFF and SVG before any decoder runs', async () => {
    for (const bytes of [
      await solid('gif'),
      await solid('tiff'),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'),
    ]) {
      expect(sniffCertificateImageFormat(bytes)).toBeNull();
      await expect(normalizeCertificateImage(bytes)).rejects.toThrow(
        /unsupported image format/,
      );
    }
  });

  it('refuses a canvas above 4096 x 4096 (decompression bomb)', async () => {
    const bomb = await solid('png', 4097, 4097);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    await expect(normalizeCertificateImage(bomb)).rejects.toThrow();
  });

  it('refuses a truncated image instead of half-decoding it', async () => {
    const png = await solid('png', 64, 64);
    await expect(
      normalizeCertificateImage(png.subarray(0, Math.floor(png.length / 2))),
    ).rejects.toThrow();
  });

  it('refuses empty input, oversize input and a PNG signature on non-PNG bytes', async () => {
    await expect(normalizeCertificateImage(Buffer.alloc(0))).rejects.toThrow();
    await expect(
      normalizeCertificateImage(
        Buffer.concat([PNG_SIGNATURE, Buffer.alloc(3 * 1024 * 1024)]),
      ),
    ).rejects.toThrow(/limit/);
    await expect(
      normalizeCertificateImage(Buffer.concat([PNG_SIGNATURE, Buffer.from('not a png')])),
    ).rejects.toThrow();
  });
});
