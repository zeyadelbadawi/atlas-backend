import {
  academySerialPrefix,
  formatSerial,
  formatVerificationCode,
  generateVerificationCode,
  isPlausibleVerificationCode,
  normalizeVerificationCode,
  VERIFICATION_ALPHABET,
} from './certificate-serial.util';

describe('certificate identifiers', () => {
  it('generates 12-character codes from the unambiguous alphabet, distinct across calls', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateVerificationCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toHaveLength(12);
      expect([...code].every((ch) => VERIFICATION_ALPHABET.includes(ch))).toBe(true);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('normalises and formats codes for display and comparison', () => {
    expect(normalizeVerificationCode('abcd-efgh-jk1m')).toBe('ABCDEFGHJK1M');
    expect(formatVerificationCode('ABCDEFGHJK1M')).toBe('ABCD-EFGH-JK1M');
    expect(isPlausibleVerificationCode('ABCD-EFGH-JK1M')).toBe(true);
    expect(isPlausibleVerificationCode('ABCD-EFGH-JKLM')).toBe(false); // L is not in the alphabet
    expect(isPlausibleVerificationCode('short')).toBe(false);
  });

  it('derives a serial prefix from the academy name, falling back to the slug', () => {
    expect(academySerialPrefix('Web Development Academy', 'wda')).toBe('WDA');
    expect(academySerialPrefix('Language Learning Hub International', 'llh')).toBe(
      'LLHI',
    );
    expect(academySerialPrefix('أكاديمية', 'arabic-academy')).toBe('ARA');
    expect(academySerialPrefix('', '')).toBe('AT');
    expect(formatSerial('WDA', 2026, 123)).toBe('WDA-2026-000123');
  });
});
