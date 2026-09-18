import { isCustomDomainLive } from './domain-liveness.util';

describe('isCustomDomainLive (P63d) — connected is not live', () => {
  const base = {
    status: 'connected',
    sslStatus: 'active',
    httpsReachable: true,
  } as const;

  it('is live only when the provider says active, the certificate is active and the probe succeeded', () => {
    expect(isCustomDomainLive(base)).toBe(true);
  });

  it('is not live while the certificate is still pending, even if the hostname is connected and the probe passed', () => {
    expect(isCustomDomainLive({ ...base, sslStatus: 'pending' })).toBe(false);
    expect(isCustomDomainLive({ ...base, sslStatus: 'provisioning' })).toBe(false);
  });

  it('is not live when the probe failed or never ran', () => {
    expect(isCustomDomainLive({ ...base, httpsReachable: false })).toBe(false);
    expect(isCustomDomainLive({ ...base, httpsReachable: null })).toBe(false);
  });

  it('is never live in any other provider status, and never for a missing row', () => {
    for (const status of [
      'not_configured',
      'pending',
      'verification_required',
      'verifying',
      'failed',
      'disconnected',
    ] as const) {
      expect(isCustomDomainLive({ ...base, status })).toBe(false);
    }
    expect(isCustomDomainLive(null)).toBe(false);
    expect(isCustomDomainLive(undefined)).toBe(false);
  });
});
