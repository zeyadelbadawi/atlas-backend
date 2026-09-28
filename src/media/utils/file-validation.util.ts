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

/** A data URL's header (`data:<mime>;base64`) is never longer than this. */
const MAX_DATA_URL_HEADER_LENGTH = 256;
const BASE64_SUFFIX = ';base64';

/**
 * Parses a `data:<mime>;base64,<payload>` URL. Rejects anything else
 * outright (a plain base64 string with no `data:` prefix, a non-base64
 * encoding) — the frontend's own `useFilePicker`/`FileReader` always
 * produces the full data-URL form (`UploadMediaAssetPayload.dataUrl`'s
 * own doc comment), so accepting a bare string would only widen the
 * surface for no real caller.
 *
 * LINEAR AND SIZE-FIRST. The payload can be tens of megabytes, so it is
 * never matched by a regular expression (a backtracking `(.+)` over it
 * exhausted V8's stack and answered 500), and when `maxBytes` is given
 * the decoded size is computed from the base64 LENGTH before anything is
 * decoded: an oversized upload is a 413 without allocating it. Malformed
 * input is a 400.
 */
export function parseDataUrl(dataUrl: string, maxBytes?: number): DataUrlParts {
  const parsed = splitBase64Payload(dataUrl, { allowBare: false });
  if (!parsed.declaredMimeType) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  const buffer = decodeBase64Checked(parsed.payload, maxBytes);
  return { declaredMimeType: parsed.declaredMimeType, buffer };
}

/**
 * A `data:` URL or bare base64 (the protected-media bridge), decoded with
 * the same linear, size-first rules as `parseDataUrl`.
 */
export function decodeBase64Upload(value: string, maxBytes?: number): Buffer {
  return decodeBase64Checked(
    splitBase64Payload(value, { allowBare: true }).payload,
    maxBytes,
  );
}

function splitBase64Payload(
  value: string,
  options: { readonly allowBare: boolean },
): { readonly declaredMimeType?: string; readonly payload: string } {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  if (!value.startsWith('data:')) {
    if (!options.allowBare) {
      throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
    }
    return { payload: value };
  }
  // Only the bounded header is searched; the payload is never scanned by a pattern.
  const comma = value.indexOf(',', 0);
  if (comma < 0 || comma > MAX_DATA_URL_HEADER_LENGTH) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  const header = value.slice('data:'.length, comma);
  if (!header.endsWith(BASE64_SUFFIX)) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  const declaredMimeType = header.slice(0, header.length - BASE64_SUFFIX.length);
  if (!declaredMimeType || declaredMimeType.includes(';')) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  return { declaredMimeType, payload: value.slice(comma + 1) };
}

/** Upper bound of the bytes a base64 string of this length decodes to. */
export function maxDecodedBase64Bytes(base64Length: number): number {
  return Math.floor((base64Length * 3) / 4);
}

function decodeBase64Checked(payload: string, maxBytes?: number): Buffer {
  if (payload.length === 0) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  // Whitespace/padding make the estimate an upper bound: never a false 413
  // for a file that decodes within the limit by more than a few bytes, so
  // the exact check below still runs on the decoded buffer.
  if (maxBytes !== undefined && maxDecodedBase64Bytes(payload.length) > maxBytes + 3) {
    throw new PayloadTooLargeException({ messageKey: 'errors.media.fileTooLarge' });
  }
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestException({ messageKey: 'errors.media.invalidDataUrl' });
  }
  if (maxBytes !== undefined) assertWithinSizeLimit(buffer, maxBytes);
  return buffer;
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

/**
 * The support-ticket counterpart of `buildStorageKey`, in this module on
 * purpose: a support attachment is stored in the SAME bucket, validated by
 * the SAME magic-byte allowlist and capped by the SAME size ceiling as
 * every other upload — only its ownership model differs (see the P53
 * migration). Keeping the key builders side by side is what stops a second
 * storage convention from growing somewhere else.
 *
 * `caseId` is a real UUID the caller has already resolved through RLS, and
 * `id` is a fresh `randomUUID()`. As with the academy form, no client
 * string (filename, mime type) is ever concatenated into a key, so
 * `../../` cannot be expressed.
 */
export function buildSupportAttachmentStorageKey(
  caseId: string,
  extension: string,
  id: string,
): string {
  return `support-cases/${caseId}/${id}.${extension}`;
}

/** Display-only — never used to address storage. Strips path separators/control characters and caps length, matching the same defensive floor `class-validator`'s `@MaxLength` gives every other free-text field in this codebase. */
export function sanitizeFileName(rawFileName: string): string {
  const stripped = rawFileName.replace(/[/\\\0]/g, '').trim();
  const safe = stripped.length > 0 ? stripped : 'file';
  return safe.slice(0, 255);
}
