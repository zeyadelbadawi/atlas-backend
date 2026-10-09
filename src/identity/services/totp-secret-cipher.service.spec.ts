import type { ConfigService } from '@nestjs/config';
import { TotpSecretCipher } from './totp-secret-cipher.service';

function buildCipher(): TotpSecretCipher {
  const configService = {
    getOrThrow: () => ({ credentialEncryptionKeyHex: 'ab'.repeat(32) }),
  } as unknown as ConfigService;
  return new TotpSecretCipher(configService);
}

describe('TotpSecretCipher', () => {
  it('round-trips a secret', () => {
    const cipher = buildCipher();
    expect(cipher.decrypt(cipher.encrypt('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
  });

  // W13 — a 4-byte prefix of the real tag used to verify, because the
  // decipher accepted any tag length from 4 to 16 bytes.
  it('refuses a truncated GCM tag (the 16-byte tag length is pinned)', () => {
    const cipher = buildCipher();
    const [iv, tag, ciphertext] = cipher.encrypt('JBSWY3DPEHPK3PXP').split('.');
    const truncated = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');

    expect(() => cipher.decrypt([iv, truncated, ciphertext].join('.'))).toThrow();
  });
});
