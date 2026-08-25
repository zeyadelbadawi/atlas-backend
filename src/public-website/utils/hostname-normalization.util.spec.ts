import { extractSubdomainLabel, normalizeHostname } from './hostname-normalization.util';

describe('normalizeHostname', () => {
  it('lowercases and trims a well-formed hostname', () => {
    expect(normalizeHostname('  Harvard.Atlas.Dev  ')).toBe('harvard.atlas.dev');
  });

  it('strips a trailing FQDN dot', () => {
    expect(normalizeHostname('harvard.atlas.dev.')).toBe('harvard.atlas.dev');
  });

  it('strips a port suffix', () => {
    expect(normalizeHostname('harvard.atlas.dev:8080')).toBe('harvard.atlas.dev');
  });

  it('accepts a bare, dot-free label (dev-override / raw subdomain candidate)', () => {
    expect(normalizeHostname('harvard')).toBe('harvard');
  });

  it('rejects null/undefined/empty input', () => {
    expect(normalizeHostname(undefined)).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname('   ')).toBeNull();
  });

  it('rejects a full URL — never accepts a scheme/path', () => {
    expect(normalizeHostname('https://example.com/path')).toBeNull();
    expect(normalizeHostname('http://example.com')).toBeNull();
  });

  it('rejects a hostname carrying a path or query string', () => {
    expect(normalizeHostname('example.com/path')).toBeNull();
    expect(normalizeHostname('example.com?x=1')).toBeNull();
    expect(normalizeHostname('example.com#frag')).toBeNull();
  });

  it('rejects embedded whitespace', () => {
    expect(normalizeHostname('exa mple.com')).toBeNull();
  });

  it('rejects non-ASCII characters (no IDN/punycode support)', () => {
    expect(normalizeHostname('exämple.com')).toBeNull();
  });

  it('rejects an empty label (double dot)', () => {
    expect(normalizeHostname('example..com')).toBeNull();
  });

  it('rejects a label starting or ending with a hyphen', () => {
    expect(normalizeHostname('-example.com')).toBeNull();
    expect(normalizeHostname('example-.com')).toBeNull();
  });

  it('accepts real, valid multi-label hostnames', () => {
    expect(normalizeHostname('my-custom-domain.example.com')).toBe(
      'my-custom-domain.example.com',
    );
  });
});

describe('extractSubdomainLabel', () => {
  it('extracts the single label from a real subdomain of the base domain', () => {
    expect(extractSubdomainLabel('harvard.atlas.dev', 'atlas.dev')).toBe('harvard');
  });

  it('returns null when no base domain is configured', () => {
    expect(extractSubdomainLabel('harvard.atlas.dev', undefined)).toBeNull();
  });

  it('returns null for the bare base domain itself', () => {
    expect(extractSubdomainLabel('atlas.dev', 'atlas.dev')).toBeNull();
  });

  it('returns null for a multi-label subdomain (a.b.atlas.dev)', () => {
    expect(extractSubdomainLabel('a.b.atlas.dev', 'atlas.dev')).toBeNull();
  });

  it('returns null for a hostname that does not end with the base domain suffix', () => {
    expect(extractSubdomainLabel('harvard.example.com', 'atlas.dev')).toBeNull();
  });

  it('never matches via substring — a lookalike domain never extracts a label', () => {
    // "notatlas.dev" does NOT end with ".atlas.dev" — must not match.
    expect(extractSubdomainLabel('notatlas.dev', 'atlas.dev')).toBeNull();
    // "harvard.atlas.dev.evil.com" must not match "atlas.dev" either.
    expect(extractSubdomainLabel('harvard.atlas.dev.evil.com', 'atlas.dev')).toBeNull();
  });

  it('is case-sensitive-safe: comparison happens on already-lowercased input', () => {
    expect(extractSubdomainLabel('harvard.atlas.dev', 'ATLAS.DEV')).toBe('harvard');
  });
});
