import { generateOpaqueToken, hashOpaqueToken } from './opaque-token.util';

describe('opaque-token.util', () => {
  it('generates unique, high-entropy tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes deterministically (same input -> same hash)', () => {
    const token = 'a-fixed-token-value-for-this-test';
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
  });

  it('the hash never equals the raw token', () => {
    const token = generateOpaqueToken();
    expect(hashOpaqueToken(token)).not.toBe(token);
  });

  it('different tokens hash differently', () => {
    expect(hashOpaqueToken(generateOpaqueToken())).not.toBe(
      hashOpaqueToken(generateOpaqueToken()),
    );
  });
});
