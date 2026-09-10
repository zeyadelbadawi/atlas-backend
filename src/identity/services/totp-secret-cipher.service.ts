/**
 * TotpSecretCipher — encrypts TOTP secrets at rest.
 *
 * WHY NOT JUST REUSE `CredentialEncryptionService`. That service exists
 * for payment-gateway credentials and holds the raw
 * `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`. Encrypting authentication secrets
 * under the *same key* as payment credentials merges two security domains
 * that should fail independently: a key disclosure in one would
 * immediately compromise the other, and key rotation for one would be
 * blocked by the other.
 *
 * WHY NOT A NEW ENVIRONMENT VARIABLE EITHER. A new REQUIRED secret would
 * stop the application booting anywhere it is not yet configured —
 * production included — turning a security improvement into an outage.
 *
 * WHAT THIS DOES INSTEAD: HKDF-SHA256 derives a distinct 32-byte key from
 * the existing key material under a fixed, purpose-specific `info` label.
 * That gives real cryptographic domain separation (the 2FA key cannot be
 * computed from the payment key without the label, and neither reveals
 * the other) at zero operational cost. If a dedicated
 * `TOTP_ENCRYPTION_KEY` is ever provisioned, it takes precedence and this
 * derivation is skipped — the constructor is the only place that would
 * need to change.
 *
 * ROTATION CAVEAT, STATED PLAINLY: rotating the underlying key
 * invalidates every stored TOTP secret, and every enrolled user would
 * have to re-enrol. That is inherent to encrypting-at-rest without a key
 * versioning scheme, and is why recovery codes exist.
 *
 * AES-256-GCM with a random 12-byte IV per encryption, and the
 * authentication tag stored alongside — tampering is detected rather than
 * silently producing garbage.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { PaymentConfigurationConfig } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

/**
 * Domain-separation label. Changing it makes every stored secret
 * undecryptable — treat as frozen.
 */
const HKDF_INFO = 'atlas.totp.secret.v1';
/**
 * HKDF salt. A fixed, non-secret value is correct here: the input key
 * material is already a high-entropy 256-bit key, and the salt's job is
 * domain separation, not entropy.
 */
const HKDF_SALT = 'atlas.totp.hkdf.salt.v1';

@Injectable()
export class TotpSecretCipher {
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const { credentialEncryptionKeyHex } =
      this.configService.getOrThrow<PaymentConfigurationConfig>('paymentConfiguration');

    const rootKey = Buffer.from(credentialEncryptionKeyHex, 'hex');
    if (rootKey.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.',
      );
    }

    // Derived, never used directly — see this class's own doc comment.
    this.key = Buffer.from(
      hkdfSync('sha256', rootKey, HKDF_SALT, HKDF_INFO, KEY_LENGTH_BYTES),
    );
  }

  /** Encrypts a base32 TOTP secret into the opaque at-rest format. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join('.');
  }

  /**
   * Decrypts a value produced by `encrypt`.
   *
   * Throws on tampering or malformed input rather than returning a
   * partial result — GCM's authentication tag makes that detectable, and
   * a silently-corrupted TOTP secret would present as "your codes stopped
   * working" with no explanation.
   */
  decrypt(encrypted: string): string {
    const parts = encrypted.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted TOTP secret.');
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
