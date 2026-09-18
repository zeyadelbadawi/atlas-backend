import { isCustomDomainLive, isCustomDomainSettled } from './domain-liveness.util';

describe('isCustomDomainLive / isCustomDomainSettled (P63d/P63e) — connected is not live', () => {
  const base = {
    status: 'connected',
    sslStatus: 'active',
    httpsReachable: true,
  } as const;

  it("is live when the provider says active and Atlas's probe got a trusted HTTPS answer", () => {
    expect(isCustomDomainLive(base)).toBe(true);
    expect(isCustomDomainSettled(base)).toBe(true);
  });

  it("is live but NOT settled while the provider's own certificate is still pending (the customer's own proxy serves HTTPS)", () => {
    expect(isCustomDomainLive({ ...base, sslStatus: 'pending' })).toBe(true);
    expect(isCustomDomainSettled({ ...base, sslStatus: 'pending' })).toBe(false);
    expect(isCustomDomainLive({ ...base, sslStatus: 'provisioning' })).toBe(true);
  });

  it('is not live when the probe failed (e.g. the edge returned 525) or never ran', () => {
    expect(isCustomDomainLive({ ...base, httpsReachable: false })).toBe(false);
    expect(isCustomDomainLive({ ...base, httpsReachable: null })).toBe(false);
    expect(isCustomDomainSettled({ ...base, httpsReachable: false })).toBe(false);
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
