import { isPlatformHost, platformAppHost, platformHosts } from './platform-host.util';

describe('platform hosts (dashboard subdomain move)', () => {
  const base = { baseDomain: 'atlass.dpdns.org' };

  it('defaults the dashboard host to dashboard.<base>', () => {
    expect(platformAppHost(base)).toBe('dashboard.atlass.dpdns.org');
    expect(platformHosts(base)).toEqual([
      'atlass.dpdns.org',
      'dashboard.atlass.dpdns.org',
    ]);
  });

  it('honours an explicit single-label subdomain of the base domain', () => {
    expect(platformAppHost({ ...base, appHost: 'app.atlass.dpdns.org' })).toBe(
      'app.atlass.dpdns.org',
    );
  });

  it('ignores a value that is not a single-label subdomain of the base domain', () => {
    for (const appHost of [
      'evil.example.com',
      'atlass.dpdns.org',
      'a.b.atlass.dpdns.org',
      'xatlass.dpdns.org',
      '-bad.atlass.dpdns.org',
    ]) {
      expect(platformAppHost({ ...base, appHost })).toBeUndefined();
      expect(platformHosts({ ...base, appHost })).toEqual(['atlass.dpdns.org']);
    }
  });

  it('ignores a label an academy could hold (not a reserved subdomain)', () => {
    for (const appHost of ['my-academy.atlass.dpdns.org', 'school.atlass.dpdns.org']) {
      expect(platformAppHost({ ...base, appHost })).toBeUndefined();
      expect(isPlatformHost(appHost, { ...base, appHost })).toBe(false);
    }
  });

  it('refuses a dashboard host longer than a DNS name allows', () => {
    const longBase = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(59)}.org`;
    expect(longBase.length).toBeLessThanOrEqual(253);
    expect(platformAppHost({ baseDomain: longBase })).toBeUndefined();
    expect(platformHosts({ baseDomain: longBase })).toEqual([longBase]);
  });

  it('has no platform host without a base domain', () => {
    expect(platformAppHost({})).toBeUndefined();
    expect(platformHosts(undefined)).toEqual([]);
    expect(isPlatformHost('dashboard.atlass.dpdns.org', {})).toBe(false);
  });

  it('matches only the exact platform hosts, case-insensitively', () => {
    expect(isPlatformHost('atlass.dpdns.org', base)).toBe(true);
    expect(isPlatformHost('DASHBOARD.atlass.dpdns.org', base)).toBe(true);
    expect(isPlatformHost('harvard.atlass.dpdns.org', base)).toBe(false);
    expect(isPlatformHost('dashboard.atlass.dpdns.org.evil.com', base)).toBe(false);
    expect(isPlatformHost(undefined, base)).toBe(false);
  });
});
