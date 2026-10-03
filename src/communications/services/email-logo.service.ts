/**
 * EmailLogoService — W3: turns an academy's stored logo into the bounded PNG
 * the public logo route serves and the email layout links to.
 *
 * ONE implementation for both sides, so the URL an email carries and the
 * bytes behind it can never disagree: the dispatcher asks `forEmail` (URL +
 * width/height, or nothing → text fallback) and
 * `GET public/websites/:academyId/logo` asks `render` (the PNG).
 *
 *  - Reads ONLY Atlas's own public media bucket (`MEDIA_STORAGE_PROVIDER`,
 *    the same public-tier store `PublicMediaController` serves from) or the
 *    inline data URI on the row. The protected bucket is never touched and
 *    no remote URL is ever fetched.
 *  - Re-encodes through sharp with a pixel limit, EXIF rotation applied,
 *    metadata stripped, fitted inside 480×160 (3× retina for the 40px
 *    display height) — always PNG.
 *  - Caches the rendered result per (academy, version) in process, and
 *    negative results briefly, so a burst of image-proxy fetches costs one
 *    decode, not one per hit. Concurrent misses for one key share ONE
 *    decode (in-flight de-duplication).
 *  - For the public route (`renderPublic`), the academy's stored logo
 *    reference is cached briefly too — unknown academy ids negatively, in a
 *    bounded map — so a flood of random ids costs no repeated database
 *    lookups (security review finding 4; the route is also throttled per IP
 *    at a ceiling generous enough for email-client bursts).
 *
 * Never throws: an unreadable, oversized or undecodable logo is `null`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import { LinkBuilderService } from './link-builder.service';
import {
  EMAIL_LOGO_MAX_SOURCE_BYTES,
  emailLogoDisplaySize,
  emailLogoVersion,
  parseEmailLogoSource,
} from '../utils/email-logo.util';

export interface RenderedEmailLogo {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly version: string;
}

export interface EmailLogoReference {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

const MAX_CACHE_ENTRIES = 200;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** Public-route reference cache: a logo change shows within this window. */
const REFERENCE_TTL_MS = 30 * 1000;
/** Unknown / ineligible academy ids. */
const REFERENCE_NEGATIVE_TTL_MS = 60 * 1000;
const MAX_REFERENCE_ENTRIES = 1_000;
/** 3× the 40px display height, and a generous width for wordmarks. */
const RENDER_BOX = { width: 480, height: 160 } as const;
/** Rejects absurd canvases before sharp allocates them (decompression bombs). */
const MAX_INPUT_PIXELS = 40_000_000;

type CacheEntry =
  | { readonly kind: 'hit'; readonly logo: RenderedEmailLogo }
  | { readonly kind: 'miss'; readonly until: number };

/** The public route path for an academy's email logo (version in the query). */
export function emailLogoPath(academyId: string, version: string): string {
  return `/api/v1/public/websites/${encodeURIComponent(academyId)}/logo?v=${version}`;
}

@Injectable()
export class EmailLogoService {
  private readonly logger = new Logger(EmailLogoService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight decodes per (academy, version). */
  private readonly decoding = new Map<string, Promise<RenderedEmailLogo | null>>();
  /** The public route's academy → stored logo reference (null = none / unknown). */
  private readonly references = new Map<
    string,
    { readonly logoUrl: string | null; readonly until: number }
  >();
  /** In-flight public-route lookups per academy. */
  private readonly resolving = new Map<string, Promise<RenderedEmailLogo | null>>();

  constructor(
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly storage: MediaStorageProvider,
    private readonly links: LinkBuilderService,
  ) {}

  /** The bounded PNG for this academy's stored logo, or `null` when there is no usable one. */
  async render(
    academyId: string,
    logoUrl: string | null | undefined,
  ): Promise<RenderedEmailLogo | null> {
    const source = parseEmailLogoSource(logoUrl, academyId);
    if (!source || !logoUrl) return null;
    const version = emailLogoVersion(logoUrl);
    const cacheKey = `${academyId}:${version}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.kind === 'hit') return cached.logo;
    if (cached?.kind === 'miss' && cached.until > Date.now()) return null;

    const pending = this.decoding.get(cacheKey);
    if (pending) return pending;
    const decoding = this.decode(source, version, academyId)
      .then((logo) => {
        this.remember(
          cacheKey,
          logo
            ? { kind: 'hit', logo }
            : { kind: 'miss', until: Date.now() + NEGATIVE_TTL_MS },
        );
        return logo;
      })
      .finally(() => this.decoding.delete(cacheKey));
    this.decoding.set(cacheKey, decoding);
    return decoding;
  }

  /**
   * The public logo route: resolves the academy's stored logo reference via
   * `loadReference` (a database read) at most once per short window per
   * academy — unknown ids included, negatively — and shares one lookup and
   * one decode among concurrent requests for the same academy.
   */
  async renderPublic(
    academyId: string,
    loadReference: () => Promise<string | null>,
  ): Promise<RenderedEmailLogo | null> {
    const known = this.references.get(academyId);
    if (known && known.until > Date.now()) {
      return known.logoUrl ? this.render(academyId, known.logoUrl) : null;
    }
    const pending = this.resolving.get(academyId);
    if (pending) return pending;
    const resolving = (async () => {
      let logoUrl: string | null;
      try {
        logoUrl = await loadReference();
      } catch (error) {
        this.logger.warn(
          { academyId, error: error instanceof Error ? error.message : String(error) },
          'Academy logo reference could not be read.',
        );
        return null;
      }
      this.rememberReference(academyId, logoUrl);
      return logoUrl ? this.render(academyId, logoUrl) : null;
    })().finally(() => this.resolving.delete(academyId));
    this.resolving.set(academyId, resolving);
    return resolving;
  }

  private rememberReference(academyId: string, logoUrl: string | null): void {
    this.references.delete(academyId);
    this.references.set(academyId, {
      logoUrl,
      until: Date.now() + (logoUrl ? REFERENCE_TTL_MS : REFERENCE_NEGATIVE_TTL_MS),
    });
    while (this.references.size > MAX_REFERENCE_ENTRIES) {
      const oldest = this.references.keys().next().value;
      if (oldest === undefined) break;
      this.references.delete(oldest);
    }
  }

  /**
   * What the email layout needs: the absolute logo URL on the PLATFORM host
   * (stable, always TLS, independent of a custom domain's health) with its
   * display size — or `undefined`, which renders the academy name instead.
   */
  async forEmail(
    academyId: string,
    logoUrl: string | null | undefined,
  ): Promise<EmailLogoReference | undefined> {
    const logo = await this.render(academyId, logoUrl);
    if (!logo) return undefined;
    const size = emailLogoDisplaySize(logo.width, logo.height);
    return {
      url: this.links.platform(emailLogoPath(academyId, logo.version)),
      width: size.width,
      height: size.height,
    };
  }

  private async decode(
    source: NonNullable<ReturnType<typeof parseEmailLogoSource>>,
    version: string,
    academyId: string,
  ): Promise<RenderedEmailLogo | null> {
    try {
      const input =
        source.kind === 'inline'
          ? source.bytes
          : await this.storage.getObject(source.storageKey);
      if (input.length === 0 || input.length > EMAIL_LOGO_MAX_SOURCE_BYTES) return null;
      const { data, info } = await sharp(input, {
        limitInputPixels: MAX_INPUT_PIXELS,
        animated: false,
      })
        .rotate()
        .resize({
          width: RENDER_BOX.width,
          height: RENDER_BOX.height,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true });
      return { png: data, width: info.width, height: info.height, version };
    } catch (error) {
      // The academy id and the reason only — never the stored value, which
      // can be a large data URI.
      this.logger.warn(
        { academyId, error: error instanceof Error ? error.message : String(error) },
        'Academy logo is not usable in email; falling back to the academy name.',
      );
      return null;
    }
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
