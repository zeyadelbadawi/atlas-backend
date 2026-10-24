import { AppleTokenCipher } from './apple-token.cipher';

const KEY = 'ab'.repeat(32);

describe('AppleTokenCipher', () => {
  it('round-trips, with a fresh IV each time', () => {
    const cipher = new AppleTokenCipher(KEY);
    const a = cipher.seal('refresh-token-1');
    const b = cipher.seal('refresh-token-1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('refresh-token-1');
    expect(cipher.open(a)).toBe('refresh-token-1');
  });

  it('a tampered or foreign value opens to nothing', () => {
    const cipher = new AppleTokenCipher(KEY);
    const sealed = cipher.seal('t');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('xx').toString('base64url');
    expect(cipher.open(parts.join('.'))).toBeNull();
    expect(new AppleTokenCipher('cd'.repeat(32)).open(sealed)).toBeNull();
    expect(cipher.open('garbage')).toBeNull();
  });
});
