import type { ConfigService } from '@nestjs/config';
import {
  WatermarkSnapshotCipher,
  deriveWatermarkSnapshotKey,
  type WatermarkIdentitySnapshot,
} from './watermark-snapshot-cipher.service';

const ROOT = '13f06a452950a7ce995920530dabd5d8d8b9e2ff7e29a1f6e7d918aae2125178';

function cipherWith(dedicatedKeyHex: string | null = null): WatermarkSnapshotCipher {
  const config = {
    getOrThrow: () => ({
      snapshotKeySource: { dedicatedKeyHex, paymentCredentialsKeyHex: ROOT },
      retentionDays: 730,
      lookupRateLimit: { max: 30, windowSeconds: 600 },
    }),
  } as unknown as ConfigService;
  return new WatermarkSnapshotCipher(config);
}

const SNAPSHOT: WatermarkIdentitySnapshot = {
  name: 'Layla Hassan',
  email: 'layla@example.com',
  phoneE164: '+201001234567',
  phoneCountry: 'EG',
  sessionSignIn: {
    ipAddress: '1.2.3.4',
    country: 'EG',
    deviceLabel: 'Chrome on Android',
    userAgent: 'UA',
  },
  target: {
    organizationName: 'Org',
    academyName: 'Academy',
    courseTitle: 'Course',
    lessonTitle: 'Lesson',
    liveSessionTitle: null,
  },
};

describe('WatermarkSnapshotCipher', () => {
  it('round-trips and never contains the plaintext', () => {
    const cipher = cipherWith();
    const encrypted = cipher.encrypt(SNAPSHOT, '7K3QMX9TR7');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain('layla');
    expect(encrypted).not.toContain('1001234567');
    expect(cipher.decrypt(encrypted, '7K3QMX9TR7')).toEqual(SNAPSHOT);
  });

  it('refuses a snapshot moved onto another code (AAD binding)', () => {
    const cipher = cipherWith();
    const encrypted = cipher.encrypt(SNAPSHOT, '7K3QMX9TR7');
    expect(() => cipher.decrypt(encrypted, 'ZZZZZZZZZ0')).toThrow();
  });

  it('derives a key distinct from the root and honours a dedicated key', () => {
    const derived = deriveWatermarkSnapshotKey({ paymentCredentialsKeyHex: ROOT });
    expect(derived.toString('hex')).not.toBe(ROOT);
    const dedicated = 'ab'.repeat(32);
    expect(
      deriveWatermarkSnapshotKey({
        dedicatedKeyHex: dedicated,
        paymentCredentialsKeyHex: ROOT,
      }).toString('hex'),
    ).toBe(dedicated);
    const encrypted = cipherWith(dedicated).encrypt(SNAPSHOT, '7K3QMX9TR7');
    expect(() => cipherWith().decrypt(encrypted, '7K3QMX9TR7')).toThrow();
  });
});
