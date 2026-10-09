/**
 * W4 — the only image decoding the certificate renderer does, narrowed to
 * what a certificate logo or signature actually is.
 *
 * The logo/signature URL is manager-supplied (own media, a data URI or a
 * vetted external host — `CertificateImageLoader`), and its bytes used to
 * go straight into `sharp(...)`, which hands them to whichever libvips
 * loader claims them: HEIF, SVG (librsvg), TIFF, PDF, and so on. Those
 * loaders are where sharp's recent high-severity advisories live
 * (GHSA-f88m-g3jw-g9cj libvips, GHSA-rgj7-g3m4-5g8c libheif,
 * GHSA-wq5f-xc86-pv6w librsvg). So, before anything is decoded:
 *
 *  - a size cap (the loader's 2 MB, re-asserted here, so the decoder never
 *    depends on every caller remembering it);
 *  - a MAGIC-BYTE allowlist — PNG, JPEG, WebP only. The format is decided
 *    from the bytes, never from a URL extension or a declared type, and
 *    nothing else ever reaches a decoder;
 *  - sharp is told the format must match (its own detection is checked
 *    again), to fail on any decoder warning (`failOn: 'warning'`, so a
 *    truncated or malformed file is refused rather than half-rendered), to
 *    refuse canvases above 4096 x 4096 (decompression bombs), and to read
 *    one frame only.
 *
 * A refusal throws; the renderer records it as a warning and lays the
 * certificate out without that image, exactly as for an unreachable URL.
 */
import sharp from 'sharp';
import { MAX_CERTIFICATE_IMAGE_BYTES } from './certificate-image-loader.service';

export type CertificateImageFormat = 'png' | 'jpeg' | 'webp';

/** 4096 x 4096 — far beyond any logo or signature, far below a bomb. */
export const MAX_CERTIFICATE_IMAGE_PIXELS = 4096 * 4096;

/** The format the BYTES say they are, or `null` for anything not allowed. */
export function sniffCertificateImageFormat(
  bytes: Buffer,
): CertificateImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Decodes an allowed image and re-encodes it as PNG for PDFKit, or throws. */
export async function normalizeCertificateImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_IMAGE_BYTES) {
    throw new Error('image is empty or larger than the certificate image limit');
  }
  const format = sniffCertificateImageFormat(bytes);
  if (!format) {
    throw new Error('unsupported image format (PNG, JPEG or WebP only)');
  }
  const image = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: MAX_CERTIFICATE_IMAGE_PIXELS,
    animated: false,
    pages: 1,
  });
  const metadata = await image.metadata();
  if (metadata.format !== format) {
    throw new Error('image content does not match its format');
  }
  return image.png().toBuffer();
}
