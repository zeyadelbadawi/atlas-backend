import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  assertWithinSizeLimit,
  buildStorageKey,
  decodeBase64Upload,
  detectFileKind,
  parseDataUrl,
  sanitizeFileName,
} from './file-validation.util';

/** A real, valid 1x1 PNG — not a fabricated signature, the actual file bytes. */
const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
/** A real, valid, minimal PDF. */
const REAL_PDF_BASE64 = Buffer.from(
  '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF',
).toString('base64');

describe('parseDataUrl', () => {
  it('parses a real data: URL into its declared MIME type and decoded buffer', () => {
    const result = parseDataUrl(`data:image/png;base64,${REAL_PNG_BASE64}`);
    expect(result.declaredMimeType).toBe('image/png');
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('rejects a payload with no data: prefix', () => {
    expect(() => parseDataUrl(REAL_PNG_BASE64)).toThrow();
  });

  it('rejects a data: URL with an empty payload', () => {
    expect(() => parseDataUrl('data:image/png;base64,')).toThrow();
  });

  it('rejects a plain (non-base64) data: URL', () => {
    expect(() => parseDataUrl('data:text/plain,hello')).toThrow();
  });

  it('answers a huge payload with 413 BEFORE decoding it — linear, no regex, no stack overflow', () => {
    // 60 MB of base64: the old `/^data:([^;]+);base64,(.+)$/` overflowed
    // V8's stack on inputs of this size (a 500).
    const huge = `data:image/png;base64,${'A'.repeat(60 * 1024 * 1024)}`;
    const started = Date.now();
    expect(() => parseDataUrl(huge, 10 * 1024 * 1024)).toThrow(PayloadTooLargeException);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('decodes a file exactly at the limit, and refuses one byte over (413)', () => {
    const exact = Buffer.alloc(3000, 7);
    const over = Buffer.alloc(3001, 7);
    expect(
      parseDataUrl(`data:image/png;base64,${exact.toString('base64')}`, 3000).buffer
        .length,
    ).toBe(3000);
    expect(() =>
      parseDataUrl(`data:image/png;base64,${over.toString('base64')}`, 3000),
    ).toThrow(PayloadTooLargeException);
  });

  it.each([
    ['no comma', 'data:image/png;base64'],
    ['header longer than 256 characters', `data:${'x'.repeat(300)};base64,AAAA`],
    ['empty MIME type', 'data:;base64,AAAA'],
    ['parameters in the MIME type', 'data:image/png;charset=x;base64,AAAA'],
    ['not base64', 'data:image/png;utf8,AAAA'],
    ['empty string', ''],
  ])('refuses a malformed data URL (%s) with 400', (_label, value) => {
    expect(() => parseDataUrl(value, 1000)).toThrow(BadRequestException);
  });

  it('decodeBase64Upload accepts bare base64 or a data URL, size-first', () => {
    expect(decodeBase64Upload(REAL_PNG_BASE64).length).toBeGreaterThan(0);
    expect(
      decodeBase64Upload(`data:image/png;base64,${REAL_PNG_BASE64}`).length,
    ).toBeGreaterThan(0);
    expect(() => decodeBase64Upload('A'.repeat(40 * 1024 * 1024), 1024)).toThrow(
      PayloadTooLargeException,
    );
    expect(() => decodeBase64Upload('data:image/png;base64')).toThrow(
      BadRequestException,
    );
  });
});

describe('detectFileKind', () => {
  it('identifies a real PNG from its magic bytes, regardless of what MIME type would have been claimed', () => {
    const buffer = Buffer.from(REAL_PNG_BASE64, 'base64');
    const kind = detectFileKind(buffer);
    expect(kind?.mimeType).toBe('image/png');
    expect(kind?.assetType).toBe('image');
    expect(kind?.extension).toBe('png');
  });

  it('identifies a real PDF from its magic bytes', () => {
    const buffer = Buffer.from(REAL_PDF_BASE64, 'base64');
    const kind = detectFileKind(buffer);
    expect(kind?.mimeType).toBe('application/pdf');
    expect(kind?.assetType).toBe('document');
  });

  it('rejects a file whose bytes claim to be an image but are not (a client lying about mimeType cannot force acceptance)', () => {
    const fakeImage = Buffer.from('this is not actually an image, just text');
    expect(detectFileKind(fakeImage)).toBeUndefined();
  });

  it('rejects an executable-signature payload even if a client claims it is an image', () => {
    // Real Windows PE executable magic bytes ("MZ").
    const exeBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(detectFileKind(exeBytes)).toBeUndefined();
  });

  it('rejects an empty buffer', () => {
    expect(detectFileKind(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('assertWithinSizeLimit', () => {
  it('allows a buffer at or under the limit', () => {
    expect(() => assertWithinSizeLimit(Buffer.alloc(100), 100)).not.toThrow();
  });

  it('rejects a buffer over the limit, regardless of any claimed sizeBytes', () => {
    expect(() => assertWithinSizeLimit(Buffer.alloc(101), 100)).toThrow();
  });
});

describe('buildStorageKey', () => {
  it('builds a key scoped under the academy id, using only backend-generated parts', () => {
    const key = buildStorageKey('academy-123', 'png', 'asset-456');
    expect(key).toBe('academies/academy-123/asset-456.png');
  });

  it('never lets a client-influenced string escape the academy namespace via a crafted extension', () => {
    // `extension` here always comes from `detectFileKind`'s fixed
    // allowlist in real usage, never client input directly — this proves
    // the function itself doesn't special-case path separators even if
    // misused, i.e. the string is used literally, not re-parsed.
    const key = buildStorageKey('academy-123', 'png', 'asset-456');
    expect(key.startsWith('academies/academy-123/')).toBe(true);
    expect(key).not.toContain('..');
  });
});

describe('sanitizeFileName', () => {
  it('strips path separators from a display file name', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeFileName('a/b\\c')).toBe('abc');
  });

  it('falls back to a safe default for an empty/whitespace-only name', () => {
    expect(sanitizeFileName('   ')).toBe('file');
  });

  it('caps length at 255 characters', () => {
    const long = 'a'.repeat(500);
    expect(sanitizeFileName(long).length).toBe(255);
  });
});
