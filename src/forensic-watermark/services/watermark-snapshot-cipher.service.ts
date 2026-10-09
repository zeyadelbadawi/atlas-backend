/**
 * WatermarkSnapshotCipher — encrypts the identity snapshot stored with a
 * forensic watermark code (docs/FORENSIC_WATERMARK.md).
 *
 * The same construction as `TotpSecretCipher`, for the same reasons: a
 * dedicated `WATERMARK_SNAPSHOT_KEY` wins when provisioned; otherwise a
 * distinct 32-byte key is HKDF-SHA256-derived from the existing
 * `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under this purpose's own frozen label,
 * so the snapshot domain neither shares a key with payment credentials or
 * 2FA secrets nor needs a new required secret to boot.
 *
 * AES-256-GCM with a random 12-byte IV, and the code itself as additional
 * authenticated data: a snapshot copied onto another row (to frame somebody
 * else for a leak) fails authentication instead of decrypting under the
 * wrong code.
 *
 * At-rest format: `v1.<iv>.<tag>.<ciphertext>` (base64 parts).
 *
 * ROTATION CAVEAT: changing whichever key source is in use makes every
 * stored snapshot unreadable. The lookup still answers (the account link,
 * session and device facts are plain columns) and says the snapshot could
 * not be read; it never guesses.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ForensicWatermarkConfig } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const VERSION = 'v1';
/** Domain-separation label. Frozen: changing it makes every snapshot unreadable. */
const HKDF_INFO = 'atlas.forensic-watermark.snapshot.v1';
const HKDF_SALT = 'atlas.forensic-watermark.hkdf.salt.v1';

/** Who was watching, as the account stood when the code was issued. */
export interface WatermarkIdentitySnapshot {
  readonly name: string | null;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly phoneCountry: string | null;
  /** How the viewer was signed in at the time — the session's own sign-in facts. */
  readonly sessionSignIn: {
    readonly ipAddress: string | null;
    readonly country: string | null;
    readonly deviceLabel: string | null;
    readonly userAgent: string | null;
  } | null;
  /** What was being shown, so the record still reads after the content is deleted. */
  readonly target: {
    readonly organizationName: string | null;
    readonly academyName: string | null;
    readonly courseTitle: string | null;
    readonly lessonTitle: string | null;
    readonly liveSessionTitle: string | null;
  };
}

export function deriveWatermarkSnapshotKey(source: {
  readonly dedicatedKeyHex?: string | null;
  readonly paymentCredentialsKeyHex: string;
}): Buffer {
  if (source.dedicatedKeyHex) {
    const key = Buffer.from(source.dedicatedKeyHex, 'hex');
    if (key.length !== KEY_LENGTH_BYTES) {
      throw new Error('WATERMARK_SNAPSHOT_KEY must be 64 hex characters.');
    }
    return key;
  }
  const root = Buffer.from(source.paymentCredentialsKeyHex, 'hex');
  if (root.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.',
    );
  }
  return Buffer.from(hkdfSync('sha256', root, HKDF_SALT, HKDF_INFO, KEY_LENGTH_BYTES));
}

@Injectable()
export class WatermarkSnapshotCipher {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<ForensicWatermarkConfig>('forensicWatermark');
    this.key = deriveWatermarkSnapshotKey(config.snapshotKeySource);
  }

  encrypt(snapshot: WatermarkIdentitySnapshot, code: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(code, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(snapshot), 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      ...[iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')),
    ].join('.');
  }

  /** Throws on tampering, a wrong code or a rotated key — never a partial result. */
  decrypt(encrypted: string, code: string): WatermarkIdentitySnapshot {
    const parts = encrypted.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Malformed watermark snapshot.');
    }
    const [, ivB64, tagB64, ciphertextB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(code, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as WatermarkIdentitySnapshot;
  }
}
