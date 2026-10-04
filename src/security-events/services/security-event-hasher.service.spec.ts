/** W3 — the keyed hashes `security_events` stores instead of an email or IP. */
import { ConfigService } from '@nestjs/config';
import { SecurityEventHasher, ipKeyPeriod } from './security-event-hasher.service';

function hasher(secret = 'test-jwt-secret-value-0123456789') {
  return new SecurityEventHasher({
    getOrThrow: () => ({ jwtAccessSecret: secret }),
  } as unknown as ConfigService);
}

describe('SecurityEventHasher', () => {
  it('hashes a normalised email deterministically and never returns the address', () => {
    const h = hasher();
    const a = h.subjectHash('User@Example.com ');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(h.subjectHash('user@example.com'));
    expect(a).not.toContain('example');
    expect(h.subjectHash('')).toBeNull();
    expect(h.subjectHash(undefined)).toBeNull();
  });

  it('is keyed: another server secret yields unrelated hashes', () => {
    expect(hasher('a-secret-0000000000000000000000').subjectHash('x@y.z')).not.toBe(
      hasher('b-secret-0000000000000000000000').subjectHash('x@y.z'),
    );
  });

  it('rotates the IP key monthly: same month correlates, next month does not', () => {
    const h = hasher();
    const oct1 = new Date('2026-10-01T00:00:00Z');
    const oct30 = new Date('2026-10-30T23:00:00Z');
    const nov1 = new Date('2026-11-01T00:00:00Z');
    expect(h.ipHash('203.0.113.7', oct1)).toBe(h.ipHash('203.0.113.7', oct30));
    expect(h.ipHash('203.0.113.7', oct1)).not.toBe(h.ipHash('203.0.113.7', nov1));
    expect(h.ipHash('203.0.113.7', oct1)).not.toContain('203');
    expect(h.ipHash(null)).toBeNull();
    expect(ipKeyPeriod(oct30)).toBe('2026-10');
  });

  it('returns one candidate hash per calendar month a filter window spans', () => {
    const h = hasher();
    const hashes = h.ipHashesForWindow(
      '203.0.113.7',
      new Date('2026-09-20T00:00:00Z'),
      new Date('2026-11-02T00:00:00Z'),
    );
    expect(hashes).toHaveLength(3);
    expect(hashes).toContain(h.ipHash('203.0.113.7', new Date('2026-10-15T00:00:00Z')));
  });
});
