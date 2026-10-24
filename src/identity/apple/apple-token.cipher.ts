/**
 * Seals the Apple refresh token at rest (AES-256-GCM). The key is an HKDF
 * derivation of `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under its own label —
 * the same domain-separation approach as `AuthChallengeCipher` and the TOTP
 * secret cipher, so no new required secret can stop the API from booting.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'atlas.apple.refresh-token.v1';
const SALT = 'atlas.apple.refresh-token.salt.v1';

export class AppleTokenCipher {
  private readonly key: Buffer;

  constructor(rootKeyHex: string) {
    const root = Buffer.from(rootKeyHex, 'hex');
    if (root.length !== 32) throw new Error('root key must be 32 bytes');
    this.key = Buffer.from(hkdfSync('sha256', root, SALT, INFO, 32));
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  open(sealed: string): string | null {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
