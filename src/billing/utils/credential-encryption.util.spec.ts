import type { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from './credential-encryption.util';

function buildService(keyHex: string): CredentialEncryptionService {
  const configService = {
    get: () => ({ credentialEncryptionKeyHex: keyHex }),
  } as unknown as ConfigService;
  return new CredentialEncryptionService(configService);
}

const VALID_KEY_HEX =
  'fdd0676972987fc315cf21cfbc8b1e030a082597f61fcd9073174ddb92b472b1'.slice(0, 64);

describe('CredentialEncryptionService', () => {
  it('round-trips arbitrary plaintext through encrypt/decrypt', () => {
    const service = buildService(VALID_KEY_HEX);
    const plaintext = JSON.stringify({ apiKey: 'super-secret-value', merchantId: '123' });

    const encrypted = service.encrypt(plaintext);
    expect(encrypted).not.toContain('super-secret-value');

    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext for the same plaintext on each call (random IV, never reused)', () => {
    const service = buildService(VALID_KEY_HEX);
    const first = service.encrypt('same-plaintext');
    const second = service.encrypt('same-plaintext');
    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe('same-plaintext');
    expect(service.decrypt(second)).toBe('same-plaintext');
  });

  it('throws on a tampered ciphertext rather than returning a garbled result (GCM auth tag)', () => {
    const service = buildService(VALID_KEY_HEX);
    const encrypted = service.encrypt('sensitive-config');
    const [iv, authTag, ciphertext] = encrypted.split('.');
    const tampered = [iv, authTag, ciphertext.slice(0, -2) + 'AA'].join('.');

    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('throws on a malformed payload rather than silently returning something', () => {
    const service = buildService(VALID_KEY_HEX);
    expect(() => service.decrypt('not-a-valid-encrypted-payload')).toThrow();
  });

  it('rejects a key that does not decode to exactly 32 bytes', () => {
    expect(() => buildService('00'.repeat(16))).toThrow();
  });
});
