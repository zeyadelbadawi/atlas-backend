/**
 * Serves stored media bytes over HTTP.
 *
 * WHY THIS EXISTS. Uploaded images rendered as broken in production. The
 * stored `url` pointed at R2's S3 API endpoint
 * (`<account>.r2.cloudflarestorage.com/<bucket>/<key>`), which is not a
 * public URL at all — it requires an AWS SigV4 signature, so a browser
 * `<img src>` receives `400 InvalidArgument: Authorization` and shows a
 * broken image. Verified directly against the live object before changing
 * anything.
 *
 * R2 CANNOT BE FIXED FROM HERE, and `R2StorageProvider` already documents
 * why: public read on an R2 bucket is a bucket-level SETTING — Managed
 * public access (an `r2.dev` subdomain) or a bound Custom Domain —
 * configured out-of-band through Cloudflare with an account-scoped token
 * this application's object-scoped runtime credential neither has nor
 * should have. Depending on that out-of-band state is exactly how this
 * broke: nothing in the app could tell that the bucket was not actually
 * public, and the failure only showed up as a broken image on a customer's
 * screen.
 *
 * SO ATLAS SERVES ITS OWN MEDIA. The bytes come back through the same
 * origin the rest of the product is served from, which means:
 *   - no dependency on Cloudflare bucket configuration that can silently
 *     drift out of sync with the application;
 *   - the R2 account hash and bucket name stop appearing in public HTML on
 *     customers' own domains;
 *   - Cloudflare already fronts that origin, so responses edge-cache.
 *
 * ACCESS MODEL — UNCHANGED, deliberately. These objects were always meant
 * to be publicly readable: the config field is literally
 * `R2_PUBLIC_URL_BASE`, `putObject` returns "the durable public URL", and
 * public Academy websites must render logos and hero images to anonymous
 * visitors. Keys carry a random UUID, so a URL is unguessable but is a
 * capability — anyone holding it can read the object. That is the model
 * this restores, not one it introduces. Student submission attachments
 * share the same pipeline by existing design (`MediaModule`'s own note),
 * and they inherit the same property they were always specified to have.
 *
 * NO DATABASE READ. The route reconstructs the storage key from its own
 * path parameters and maps the extension to a content type from the same
 * allowlist the upload validator enforces, so serving an image costs one
 * object read and no query. Archived assets keep serving on purpose:
 * archiving means "hide it from the library", and pages already using an
 * asset are documented to keep working.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../storage/media-storage.interface';

/** A v4 UUID, which is what both the academy id and every generated object name are. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Extension → content type, limited to exactly what the upload validator
 * accepts by magic-byte sniffing. Serving is therefore never able to
 * announce a type the system would not have stored in the first place, and
 * an unknown extension is refused rather than guessed at or served as
 * `application/octet-stream`.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

@Controller('public/media')
export class PublicMediaController {
  constructor(
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storage: MediaStorageProvider,
  ) {}

  /**
   * The path mirrors the storage key's own shape
   * (`academies/{academyId}/{uuid}.{ext}`) as SEPARATE, individually
   * validated parameters rather than a wildcard. A wildcard would hand a
   * caller-controlled string straight to the object store; two strict
   * parameters make a traversal or a read outside the academies prefix
   * structurally impossible rather than merely filtered.
   */
  @Get('academies/:academyId/:fileName')
  // Immutable content: the object name is a UUID generated at upload and an
  // asset's bytes are never replaced (there is no re-upload contract), so a
  // long-lived immutable cache is safe and keeps repeat views off the
  // origin entirely.
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  async serve(
    @Param('academyId') academyId: string,
    @Param('fileName') fileName: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!UUID_PATTERN.test(academyId)) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }

    const [name, extension] = splitFileName(fileName);
    const contentType = extension ? CONTENT_TYPES[extension.toLowerCase()] : undefined;
    if (!name || !UUID_PATTERN.test(name) || !contentType) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }

    const key = `academies/${academyId}/${name}.${extension}`;

    let body: Buffer;
    try {
      body = await this.storage.getObject(key);
    } catch {
      // A missing object is a 404, not a 500 — a stale reference to an
      // asset that no longer exists is an ordinary condition, and leaking
      // the storage error would say more about the backend than a public
      // caller should learn.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    response.setHeader('Content-Type', contentType);
    // Belt and braces for a route that returns caller-influenced bytes:
    // stops a browser from re-interpreting a stored file as something
    // other than the type declared above.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // S11 (master plan §D.5/§L) — advertise range support so a browser can
    // seek within an audio/video asset instead of re-downloading it whole.
    response.setHeader('Accept-Ranges', 'bytes');

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const parsed = parseByteRange(rangeHeader, body.byteLength);
      if (parsed === 'unsatisfiable') {
        // 416 must carry the real size so the client can retry correctly.
        response.setHeader('Content-Range', `bytes */${body.byteLength}`);
        response.status(416).end();
        return;
      }
      if (parsed) {
        const slice = body.subarray(parsed.start, parsed.end + 1);
        response.setHeader(
          'Content-Range',
          `bytes ${parsed.start}-${parsed.end}/${body.byteLength}`,
        );
        response.setHeader('Content-Length', slice.byteLength);
        response.status(206).end(slice);
        return;
      }
      // A malformed range header is ignored (RFC 7233 §3.1): fall through and
      // serve the whole representation with 200.
    }

    response.setHeader('Content-Length', body.byteLength);
    response.status(200).end(body);
  }
}

/** Splits on the LAST dot, so a name containing dots cannot smuggle an extension. */
function splitFileName(fileName: string): readonly [string, string | undefined] {
  const index = fileName.lastIndexOf('.');
  if (index <= 0) return [fileName, undefined];
  return [fileName.slice(0, index), fileName.slice(index + 1)];
}

/**
 * Parses a single-range `Range: bytes=…` header against a known size
 * (RFC 7233). Returns the inclusive `{start,end}` for a satisfiable range,
 * `'unsatisfiable'` for a well-formed range entirely past the end (→ 416),
 * or `null` for anything we don't honour (multiple ranges, a syntactically
 * invalid header) so the caller serves the whole representation with 200.
 * Only `bytes` and a single range are supported — enough for media seeking,
 * and a bounded surface for a public endpoint.
 */
export function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  // A start at or past the end is unsatisfiable (416) even when the header
  // left the end open (`bytes=2000-`), so this precedes the inverted-range
  // check, which would otherwise mask it as a plain malformed range.
  if (start >= size) return 'unsatisfiable';
  if (start > end) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}
