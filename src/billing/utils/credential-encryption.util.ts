/**
 * CredentialEncryptionService — the ONE place
 * `organization_gateway_credentials.encrypted_config` is ever encrypted or
 * decrypted (master plan §5.8, §16: "Credentials must be stored server-side
 * only and encrypted at rest"). No other file in this codebase calls
 * `createCipheriv`/`createDecipheriv` for this purpose — mirrors
 * `webhook-signature.util.ts`'s identical "one seam, `node:crypto` only, no
 * new dependency" precedent.
 *
 * AES-256-GCM: a 32-byte key (`PAYMENT_CREDENTIALS_ENCRYPTION_KEY`, hex-
 * decoded), a fresh random 12-byte IV per encryption (GCM's recommended IV
 * length — never reused, never derived from anything predictable), and the
 * GCM authentication tag stored alongside the ciphertext so tampering is
 * detected on decrypt, not silently accepted. Ciphertext is serialized as
 * `base64(iv).base64(authTag).base64(ciphertext)` — three dot-separated
 * base64 segments, one opaque string, exactly what the `encrypted_config`
 * column stores.
 *
 * Plaintext NEVER reaches a log line, an exception message, or an HTTP
 * response — every caller of `decrypt()` in this codebase is a
 * `PaymentProviderAdapter.testConnection()` call happening entirely
 * server-side (see `ManualTransferProvider`/future gateway adapters); no
 * controller or DTO in `src/billing/` ever holds a decrypted value.
 */
import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { PaymentConfigurationConfig } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

@Injectable()
export class CredentialEncryptionService {
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const { credentialEncryptionKeyHex } =
      this.configService.get<PaymentConfigurationConfig>('paymentConfiguration')!;
    this.key = Buffer.from(credentialEncryptionKeyHex, 'hex');
    // `env.validation.ts`'s regex already guarantees 64 hex chars at boot —
    // this is a defensive, redundant floor, never the primary check.
    if (this.key.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.',
      );
    }
  }

  /** Encrypts an arbitrary plaintext string (a JSON-serialized gateway config) into the opaque `encrypted_config` storage format. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join('.');
  }

  /** Decrypts a value produced by `encrypt()`. Throws (never returns a partial/garbled result) if the ciphertext was tampered with or the format is malformed — GCM's authentication tag makes this detectable, not a silent corruption. */
  decrypt(encrypted: string): string {
    const parts = encrypted.split('.');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted credential payload.');
    }
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }
}
