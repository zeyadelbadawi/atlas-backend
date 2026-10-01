/**
 * CertificateImageLoader — reads a certificate's logo / signature bytes
 * WITHOUT turning the renderer into an SSRF primitive.
 *
 * A template's logo and signature are author-supplied strings (any Academy
 * manager can set them through the API), and an Academy's legacy
 * `logoUrl` may be an absolute URL. The renderer used to `fetch` whatever
 * http(s) URL it was handed, following redirects, which let a manager make
 * the API server request internal addresses (loopback, RFC 1918, cloud
 * metadata) on every render. Three sources are now distinguished:
 *
 *   1. OWN MEDIA — `/api/v1/public/media/academies/<uuid>/<uuid>.<ext>`,
 *      relative or absolute on the platform domain (or one of its
 *      subdomains). Read straight from the media store: no HTTP at all.
 *      The path is parsed with the same strict shape the public media
 *      route enforces, so only a public media object can be read.
 *   2. `data:image/...;base64,…` — decoded in-process.
 *   3. Anything else http(s) — fetched only through a vetted connection:
 *      standard ports only, the hostname is resolved first and refused if
 *      ANY address is not public unicast (outbound-address.util), the
 *      socket is pinned to the vetted address (no DNS rebinding between
 *      check and connect), redirects are never followed, and the body is
 *      streamed under a byte cap and a timeout.
 *
 * Failures never throw: they return `null` and push a warning, exactly as
 * before, so a broken logo never blocks issuing a certificate.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import {
  isIpLiteralHostname,
  isPublicAddress,
} from '../../domain/utils/outbound-address.util';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';

export const MAX_CERTIFICATE_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5_000;

const UUID =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Exactly the public media route's shape, limited to image extensions. */
const OWN_MEDIA_PATH = new RegExp(
  `^/api/v1/public/media/academies/(${UUID})/(${UUID})\\.(png|jpe?g|gif|webp)$`,
);
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i;

/** Resolves with the one address to connect to, or the reason it is refused. */
export type VettedAddress =
  | { readonly address: string; readonly family: 4 | 6 }
  | { readonly refused: 'ip_literal' | 'non_public_address' | 'unresolvable' };

export type AddressResolver = (hostname: string) => Promise<VettedAddress>;

export const resolvePublicAddress: AddressResolver = async (hostname) => {
  if (isIpLiteralHostname(hostname)) return { refused: 'ip_literal' };
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { refused: 'unresolvable' };
  }
  if (addresses.length === 0) return { refused: 'unresolvable' };
  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    return { refused: 'non_public_address' };
  }
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
};

/** Injection token for the resolver, so tests can pin DNS without the network. */
export const CERTIFICATE_ADDRESS_RESOLVER = Symbol('CERTIFICATE_ADDRESS_RESOLVER');

@Injectable()
export class CertificateImageLoader {
  private readonly baseDomain: string | null;
  private readonly resolveAddress: AddressResolver;

  constructor(
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly storage: MediaStorageProvider,
    @Optional() configService?: ConfigService,
    @Optional() @Inject(CERTIFICATE_ADDRESS_RESOLVER) resolver?: AddressResolver,
  ) {
    const platformDomain =
      configService?.get<PlatformDomainRuntimeConfig>('platformDomain');
    this.baseDomain = platformDomain?.baseDomain?.toLowerCase() || null;
    this.resolveAddress = resolver ?? resolvePublicAddress;
  }

  async load(
    url: string | null,
    label: string,
    warnings: string[],
  ): Promise<Buffer | null> {
    if (!url) return null;
    const value = url.trim();
    try {
      if (value.startsWith('data:')) return this.decodeDataUri(value, label, warnings);

      const ownKey = this.ownMediaKey(value);
      if (ownKey) return await this.readOwnMedia(ownKey, label, warnings);

      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        warnings.push(`${label}: unsupported URL`);
        return null;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        warnings.push(`${label}: unsupported URL scheme`);
        return null;
      }
      return await this.fetchVetted(parsed, label, warnings);
    } catch (error) {
      warnings.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** The storage key for an own-media reference, or `null` when `value` is not one. */
  ownMediaKey(value: string): string | null {
    let path: string;
    if (value.startsWith('/')) {
      path = value;
    } else {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
      if (parsed.search || parsed.hash || !this.isPlatformHost(parsed.hostname))
        return null;
      path = parsed.pathname;
    }
    const match = OWN_MEDIA_PATH.exec(path);
    return match ? `academies/${match[1]}/${match[2]}.${match[3]}` : null;
  }

  private isPlatformHost(hostname: string): boolean {
    if (!this.baseDomain) return false;
    const host = hostname.toLowerCase();
    return host === this.baseDomain || host.endsWith(`.${this.baseDomain}`);
  }

  private async readOwnMedia(key: string, label: string, warnings: string[]) {
    let bytes: Buffer;
    try {
      bytes = await this.storage.getObject(key);
    } catch {
      warnings.push(`${label}: media not found`);
      return null;
    }
    if (bytes.length > MAX_CERTIFICATE_IMAGE_BYTES) {
      warnings.push(`${label}: too large`);
      return null;
    }
    return bytes;
  }

  private decodeDataUri(value: string, label: string, warnings: string[]) {
    const match = DATA_IMAGE.exec(value);
    if (!match) {
      warnings.push(`${label}: unsupported data URI`);
      return null;
    }
    // base64 inflates by 4/3: refuse before decoding anything oversized.
    if (match[2].length > Math.ceil((MAX_CERTIFICATE_IMAGE_BYTES * 4) / 3) + 4) {
      warnings.push(`${label}: too large`);
      return null;
    }
    const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
    if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_IMAGE_BYTES) {
      warnings.push(`${label}: ${bytes.length === 0 ? 'empty image' : 'too large'}`);
      return null;
    }
    return bytes;
  }

  /** The port connected to; always the scheme's standard port (a test seam, nothing more). */
  protected portFor(secure: boolean): number {
    return secure ? 443 : 80;
  }

  private async fetchVetted(url: URL, label: string, warnings: string[]) {
    const secure = url.protocol === 'https:';
    // Standard ports only: an image host never needs anything else, and it
    // keeps the fetch from probing arbitrary services on a public address.
    if (url.port && url.port !== (secure ? '443' : '80')) {
      warnings.push(`${label}: non-standard port refused`);
      return null;
    }
    if (url.username || url.password) {
      warnings.push(`${label}: credentials in URL refused`);
      return null;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const vetted = await this.resolveAddress(hostname);
    if ('refused' in vetted) {
      warnings.push(`${label}: address refused (${vetted.refused})`);
      return null;
    }

    return new Promise<Buffer | null>((resolve) => {
      let settled = false;
      const finish = (value: Buffer | null, warning?: string) => {
        if (settled) return;
        settled = true;
        if (warning) warnings.push(`${label}: ${warning}`);
        resolve(value);
      };
      const request = secure ? httpsRequest : httpRequest;
      const req = request(
        {
          protocol: url.protocol,
          host: hostname,
          servername: secure ? hostname : undefined,
          port: this.portFor(secure),
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: {
            'user-agent': 'atlas-certificate-renderer/1',
            accept: 'image/*',
            connection: 'close',
          },
          timeout: IMAGE_TIMEOUT_MS,
          // Pin the connection to the vetted address: no second resolution.
          lookup: ((
            _host: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) =>
            options?.all
              ? callback(null, [{ address: vetted.address, family: vetted.family }])
              : callback(null, vetted.address, vetted.family)) as never,
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            req.destroy();
            return finish(null, 'redirect refused');
          }
          if (status < 200 || status >= 300) {
            res.resume();
            req.destroy();
            return finish(null, `HTTP ${status}`);
          }
          const declared = Number(res.headers['content-length'] ?? 0);
          if (declared > MAX_CERTIFICATE_IMAGE_BYTES) {
            req.destroy();
            return finish(null, 'too large');
          }
          const chunks: Buffer[] = [];
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_CERTIFICATE_IMAGE_BYTES) {
              req.destroy();
              finish(null, 'too large');
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => finish(Buffer.concat(chunks)));
          res.on('error', (error) => finish(null, error.message));
        },
      );
      const deadline = setTimeout(
        () => req.destroy(new Error('timeout')),
        IMAGE_TIMEOUT_MS,
      );
      req.on('close', () => clearTimeout(deadline));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (error) => finish(null, error.message));
      req.end();
    });
  }
}
