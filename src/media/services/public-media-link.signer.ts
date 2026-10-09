/**
 * W1 — short-lived, Atlas-signed links to objects in the PUBLIC media
 * bucket that must not be publicly readable.
 *
 * WHY THIS EXISTS. Two kinds of object are in the public bucket for
 * historical reasons and are not meant for anonymous eyes:
 *   - assignment-submission attachments uploaded before P64 Phase 3 moved
 *     them to the protected tier (`MediaService.uploadForSubmission`, now
 *     removed);
 *   - lesson files/resources attached from the public library before
 *     `upsertLessonContent` started refusing non-protected assets.
 * `public/media` now refuses those to anonymous callers
 * (`PublicMediaAccessService`); the people entitled to them — the learner
 * whose submission it is, the course's reviewers, an enrolled learner
 * playing the lesson — get a link signed here instead, from the same
 * grant paths that already sign protected objects
 * (`ContentGrantSigner.signFile`). It keeps those objects readable
 * WITHOUT copying a single byte, which a data migration can then do at
 * leisure (see the W1 notes).
 *
 * THE LINK. `/api/v1/public/media/<storageKey>?exp=<unix s>&sig=<b64url>`
 * where `sig = HMAC-SHA256(key, "v1\n" + storageKey + "\n" + exp)`. It is
 * bound to exactly one object and one expiry, and it is served
 * `private, no-store`, so neither a shared cache nor the edge keeps a copy
 * after it dies.
 *
 * THE KEY is derived (HKDF-SHA256) from `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`
 * under its own frozen label, the established pattern for Atlas's derived
 * keys (TOTP, sign-in challenges, the known-device cookie): one secret to
 * provision, domain-separated so no derived key can stand in for another.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { PaymentConfigurationConfig } from '../../config/configuration';
import { toMediaAssetUrl } from '../dto/media-asset.contract';

const KEY_LENGTH_BYTES = 32;
/** Frozen domain-separation labels — changing either invalidates every live link. */
const HKDF_SALT = 'atlas.public-media.link.hkdf.salt.v1';
const HKDF_INFO = 'atlas.public-media.link.v1';
/** No signed link is ever minted for longer; anything claiming more is refused. */
export const MAX_PUBLIC_MEDIA_LINK_TTL_SECONDS = 60 * 60;

export interface SignedPublicMediaLink {
  readonly url: string;
  readonly expiresAt: Date;
}

@Injectable()
export class PublicMediaLinkSigner {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const { credentialEncryptionKeyHex } =
      configService.getOrThrow<PaymentConfigurationConfig>('paymentConfiguration');
    const root = Buffer.from(credentialEncryptionKeyHex, 'hex');
    if (root.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.',
      );
    }
    this.key = Buffer.from(
      hkdfSync('sha256', root, HKDF_SALT, HKDF_INFO, KEY_LENGTH_BYTES),
    );
  }

  sign(
    storageKey: string,
    ttlSeconds: number,
    now: number = Date.now(),
  ): SignedPublicMediaLink {
    const ttl = Math.max(
      1,
      Math.min(Math.floor(ttlSeconds), MAX_PUBLIC_MEDIA_LINK_TTL_SECONDS),
    );
    const exp = Math.floor(now / 1000) + ttl;
    const query = new URLSearchParams({
      exp: String(exp),
      sig: this.mac(storageKey, exp),
    });
    return {
      url: `${toMediaAssetUrl(storageKey)}?${query.toString()}`,
      expiresAt: new Date(exp * 1000),
    };
  }

  /** True only for an unexpired link Atlas minted for exactly this object. */
  verify(
    storageKey: string,
    exp: string | undefined,
    sig: string | undefined,
    now: number = Date.now(),
  ): boolean {
    if (typeof exp !== 'string' || typeof sig !== 'string') return false;
    if (!/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
    const expSeconds = Number(exp);
    const nowSeconds = Math.floor(now / 1000);
    if (expSeconds <= nowSeconds) return false;
    if (expSeconds > nowSeconds + MAX_PUBLIC_MEDIA_LINK_TTL_SECONDS) return false;
    const expected = Buffer.from(this.mac(storageKey, expSeconds), 'utf8');
    const provided = Buffer.from(sig, 'utf8');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  }

  private mac(storageKey: string, exp: number): string {
    return createHmac('sha256', this.key)
      .update(`v1\n${storageKey}\n${exp}`, 'utf8')
      .digest('base64url');
  }
}
