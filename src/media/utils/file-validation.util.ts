/**
 * File validation for the V1 base64-bridge upload path (master plan §11,
 * §13, §16 "File upload"). Every rule here exists because the client is
 * never trusted: the claimed `mimeType`, the claimed `sizeBytes`, and the
 * claimed `fileName` are all just labels — the only facts this module
 * trusts are the decoded bytes themselves.
 *
 * A hand-rolled, fixed-signature magic-byte check (not a dependency) is
 * deliberate: the V1 allowlist is five MIME types total, each with a
 * short, well-known, stable byte signature — adding a package for this
 * would be the "duplicate abstraction" the master plan's own inspect-
 * first instruction warns against for a case this narrow.
 *
 * Video is deliberately absent from every table below — no video upload
 * pipeline exists in this phase (master plan §13 V2, `SPECIFICATION-
 * UNDEFINED`, §24); a video MIME type is rejected the same way an
 * unrecognized one is, not specially detected and then refused.
 */
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { MediaAssetType } from '@prisma/client';

export interface AllowedFileKind {
  readonly mimeType: string;
  readonly extension: string;
  readonly assetType: MediaAssetType;
  readonly signature: (buffer: Buffer) => boolean;
}

const ALLOWED_KINDS: readonly AllowedFileKind[] = [
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    assetType: 'image',
    signature: (buf) =>
      buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    extension: 'png',
    assetType: 'image',
    signature: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a,
  },
  {
    mimeType: 'image/gif',
    extension: 'gif',
    assetType: 'image',
    signature: (buf) =>
      buf.length >= 6 &&
      buf.subarray(0, 3).toString('ascii') === 'GIF' &&
      (buf.subarray(3, 6).toString('ascii') === '87a' ||
        buf.subarray(3, 6).toString('ascii') === '89a'),
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    assetType: 'image',
    signature: (buf) =>
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mimeType: 'application/pdf',
    extension: 'pdf',
    assetType: 'document',
    signature: (buf) =>
      buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-',
  },
];

export interface DataUrlParts {
  readonly declaredMimeType: string;
  readonly buffer: Buffer;
}

/**
 * Parses a `data:<mime>;base64,<payload>` URL. Rejects anything else
 * outright (a plain base64 string with no `data:` prefix, a non-base64
 * encoding) — the frontend's own `useFilePicker`/`FileReader` always
 * produces the full data-URL form (`UploadMediaAssetPayload.dataUrl`'s
 * own doc comment), so accepting a bare string would only widen the
 * surface for no real caller.
 */
export function parseDataUrl(dataUrl: string): DataUrlParts {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  const [, declaredMimeType, payload] = match;
  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  if (buffer.length === 0) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  return { declaredMimeType, buffer };
}

/**
 * The one real security check: identifies the file kind from its actual
 * bytes, never the client-declared `mimeType`. Returns `undefined` for
 * anything outside the fixed V1 allowlist — the caller rejects, it never
 * falls back to trusting the declared type.
 */
export function detectFileKind(buffer: Buffer): AllowedFileKind | undefined {
  return ALLOWED_KINDS.find((kind) => kind.signature(buffer));
}

export function assertWithinSizeLimit(buffer: Buffer, maxBytes: number): void {
  if (buffer.length > maxBytes) {
    throw new PayloadTooLargeException({ messageKey: 'errors.media.fileTooLarge' });
  }
}

/**
 * A safe, backend-generated storage key — the client never supplies any
 * part of this (master plan §13: "the client must not be able to choose
 * `../../other-academy/file`"). `academyId` is a real UUID from the
 * already-verified `AcademyScopeGuard` context, never request input;
 * `randomUUID()` + the sniffed extension is the entire remainder — no
 * client string (filename, mime type) is ever concatenated into a key.
 */
export function buildStorageKey(
  academyId: string,
  extension: string,
  id: string,
): string {
  return `academies/${academyId}/${id}.${extension}`;
}

/** Display-only — never used to address storage. Strips path separators/control characters and caps length, matching the same defensive floor `class-validator`'s `@MaxLength` gives every other free-text field in this codebase. */
export function sanitizeFileName(rawFileName: string): string {
  const stripped = rawFileName.replace(/[/\\\0]/g, '').trim();
  const safe = stripped.length > 0 ? stripped : 'file';
  return safe.slice(0, 255);
}
