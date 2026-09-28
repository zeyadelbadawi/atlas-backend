import {
  flowSecretMatches,
  hashFlowSecret,
  isGoogleAuthoritative,
  newFlowSecret,
  pkceChallenge,
  sanitizeReturnPath,
} from './google-flow.util';

describe('google-flow.util', () => {
  it('PKCE S256 matches the RFC 7636 appendix B vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('secrets are 256-bit URL-safe, stored only as SHA-256, compared in constant time', () => {
    const secret = newFlowSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = hashFlowSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(flowSecretMatches(secret, hash)).toBe(true);
    expect(flowSecretMatches(newFlowSecret(), hash)).toBe(false);
    expect(flowSecretMatches(undefined, hash)).toBe(false);
    expect(flowSecretMatches('', hash)).toBe(false);
  });

  it.each([
    ['/my', '/my'],
    ['/dashboard/courses?tab=2#x', '/dashboard/courses?tab=2#x'],
    ['https://evil.example/', null],
    ['//evil.example', null],
    ['/\\evil.example', null],
    ['javascript:alert(1)', null],
    ['my', null],
    ['', null],
    ['/a\nb', null],
    [42, null],
  ])('return path %p → %p', (input, expected) => {
    expect(sanitizeReturnPath(input)).toBe(expected);
  });

  it('Google is authoritative only for verified gmail.com or its own Workspace domain', () => {
    expect(isGoogleAuthoritative({ email: 'a@gmail.com', emailVerified: true })).toBe(
      true,
    );
    expect(isGoogleAuthoritative({ email: 'a@gmail.com', emailVerified: false })).toBe(
      false,
    );
    expect(
      isGoogleAuthoritative({
        email: 'a@company.com',
        emailVerified: true,
        hostedDomain: 'company.com',
      }),
    ).toBe(true);
    // A consumer Google account created with a company address: no `hd`.
    expect(isGoogleAuthoritative({ email: 'a@company.com', emailVerified: true })).toBe(
      false,
    );
    // `hd` naming a different domain than the address.
    expect(
      isGoogleAuthoritative({
        email: 'a@company.com',
        emailVerified: true,
        hostedDomain: 'other.com',
      }),
    ).toBe(false);
  });
});
