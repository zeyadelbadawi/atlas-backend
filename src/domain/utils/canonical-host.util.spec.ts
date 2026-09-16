import { resolveCanonicalHost, resolveSubdomainHost } from './canonical-host.util';

describe('canonical-host.util (P63)', () => {
  it('a connected custom domain is canonical, lower-cased', () => {
    expect(
      resolveCanonicalHost({
        connectedCustomHostname: 'WWW.Example.com',
        subdomainFullHost: 'harvard.atlas.dev',
        subdomainLabel: 'harvard',
        baseDomain: 'atlas.dev',
      }),
    ).toEqual({ host: 'www.example.com', source: 'custom_domain' });
  });

  it('demotes a connected custom domain whose last HTTPS probe failed, but not one never probed', () => {
    const base = {
      subdomainFullHost: 'harvard.atlas.dev',
      subdomainLabel: 'harvard',
      baseDomain: 'atlas.dev',
    };
    expect(
      resolveCanonicalHost({
        ...base,
        connectedCustomHostname: 'www.example.com',
        customHttpsReachable: false,
      }),
    ).toEqual({ host: 'harvard.atlas.dev', source: 'subdomain' });
    expect(
      resolveCanonicalHost({
        ...base,
        connectedCustomHostname: 'www.example.com',
        customHttpsReachable: null,
      }),
    ).toEqual({ host: 'www.example.com', source: 'custom_domain' });
    expect(
      resolveCanonicalHost({
        ...base,
        connectedCustomHostname: 'www.example.com',
        customHttpsReachable: true,
      }),
    ).toEqual({ host: 'www.example.com', source: 'custom_domain' });
  });

  it('falls back to the allocation full host when no custom domain is connected', () => {
    expect(
      resolveCanonicalHost({
        connectedCustomHostname: null,
        subdomainFullHost: 'Harvard.Atlas.dev',
        subdomainLabel: 'harvard',
        baseDomain: 'atlas.dev',
      }),
    ).toEqual({ host: 'harvard.atlas.dev', source: 'subdomain' });
  });

  it('derives the subdomain host from label + base domain when the allocation carries no full host', () => {
    expect(
      resolveSubdomainHost({
        subdomainFullHost: null,
        subdomainLabel: 'harvard',
        baseDomain: 'atlas.dev',
      }),
    ).toBe('harvard.atlas.dev');
  });

  it('never fabricates a host: no custom domain and no base domain yields null', () => {
    expect(
      resolveCanonicalHost({
        connectedCustomHostname: undefined,
        subdomainFullHost: null,
        subdomainLabel: 'harvard',
        baseDomain: undefined,
      }),
    ).toBeNull();
    expect(
      resolveSubdomainHost({
        subdomainFullHost: null,
        subdomainLabel: null,
        baseDomain: 'atlas.dev',
      }),
    ).toBeNull();
  });
});
