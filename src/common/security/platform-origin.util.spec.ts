import { isPlatformOrigin } from './platform-origin.util';
import { hstsPerHost } from './helmet.options';
import {
  isPrivateOrLoopback,
  resolveClientIp,
} from '../../identity/utils/request-metadata.util';

describe('isPlatformOrigin (P63g) — CORS allow-rule without regex interpolation', () => {
  it('allows the base domain and single-label subdomains over https only', () => {
    expect(isPlatformOrigin('https://atlass.dpdns.org', 'atlass.dpdns.org')).toBe(true);
    expect(isPlatformOrigin('https://harvard.atlass.dpdns.org', 'atlass.dpdns.org')).toBe(
      true,
    );
    expect(isPlatformOrigin('https://HARVARD.Atlass.dpdns.org', 'atlass.dpdns.org')).toBe(
      true,
    );
    expect(isPlatformOrigin('http://harvard.atlass.dpdns.org', 'atlass.dpdns.org')).toBe(
      false,
    );
    expect(isPlatformOrigin('https://a.b.atlass.dpdns.org', 'atlass.dpdns.org')).toBe(
      false,
    );
    expect(
      isPlatformOrigin('https://harvard.atlass.dpdns.org:8443', 'atlass.dpdns.org'),
    ).toBe(false);
    expect(isPlatformOrigin('https://rawc.ae', 'atlass.dpdns.org')).toBe(false);
    expect(
      isPlatformOrigin('https://atlass.dpdns.org.evil.com', 'atlass.dpdns.org'),
    ).toBe(false);
    expect(isPlatformOrigin('https://evilatlass.dpdns.org', 'atlass.dpdns.org')).toBe(
      false,
    );
  });

  it('a hostile-looking base domain can no longer open the allow-list', () => {
    expect(isPlatformOrigin('https://evil.com', 'atlas.dev|evil.com')).toBe(false);
    expect(isPlatformOrigin('https://x.atlas.dev', undefined)).toBe(false);
  });
});

describe('hstsPerHost (P63g) — includeSubDomains only where Atlas owns the tree', () => {
  function run(host: string, base = 'atlass.dpdns.org'): string {
    let value = '';
    hstsPerHost(base)(
      { hostname: host, headers: {} },
      {
        setHeader: (_n, v) => {
          value = v;
        },
      },
      () => undefined,
    );
    return value;
  }
  it('platform and subdomain hosts get includeSubDomains; a customer apex does not', () => {
    expect(run('atlass.dpdns.org')).toBe('max-age=31536000; includeSubDomains');
    expect(run('ghg.atlass.dpdns.org')).toBe('max-age=31536000; includeSubDomains');
    expect(run('rawc.ae')).toBe('max-age=31536000');
    expect(run('learn.rawc.ae')).toBe('max-age=31536000');
  });
});

describe('resolveClientIp (P63g) — the production trust model', () => {
  const req = (peer: string, headers: Record<string, string>) =>
    ({ socket: { remoteAddress: peer }, ip: peer, headers }) as never;

  it('trusts X-Real-IP only when the peer is the proxy (private/loopback)', () => {
    expect(resolveClientIp(req('172.18.0.5', { 'x-real-ip': '203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
    expect(resolveClientIp(req('::ffff:10.0.0.2', { 'x-real-ip': '203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
  });

  it('ignores every forwarded header from a direct (public) peer', () => {
    expect(
      resolveClientIp(
        req('198.51.100.4', {
          'x-real-ip': '1.1.1.1',
          'cf-connecting-ip': '2.2.2.2',
          'x-forwarded-for': '3.3.3.3',
        }),
      ),
    ).toBe('198.51.100.4');
  });

  it('classifies private ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '::1',
      'fd12::1',
      'fe80::1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPrivateOrLoopback(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '104.21.42.225', '2606:4700::1']) {
      expect(isPrivateOrLoopback(ip)).toBe(false);
    }
  });
});
