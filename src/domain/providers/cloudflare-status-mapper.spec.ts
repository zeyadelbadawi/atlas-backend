import {
  mapCloudflareCdnStatus,
  mapCloudflareCustomHostname,
  mapCloudflareHostnameStatus,
  mapCloudflareSslStatus,
} from './cloudflare-status-mapper';
import type { CloudflareCustomHostname } from './cloudflare-provider.interface';

describe('mapCloudflareHostnameStatus', () => {
  it('maps active-family statuses to connected', () => {
    expect(mapCloudflareHostnameStatus('active')).toBe('connected');
    expect(mapCloudflareHostnameStatus('active_redeploying')).toBe('connected');
    expect(mapCloudflareHostnameStatus('test_active')).toBe('connected');
    expect(mapCloudflareHostnameStatus('test_active_apex')).toBe('connected');
  });

  it('maps pending-family statuses to verifying', () => {
    expect(mapCloudflareHostnameStatus('pending')).toBe('verifying');
    expect(mapCloudflareHostnameStatus('pending_migration')).toBe('verifying');
    expect(mapCloudflareHostnameStatus('pending_provisioned')).toBe('verifying');
    expect(mapCloudflareHostnameStatus('provisioned')).toBe('verifying');
  });

  it('maps deletion-family statuses to disconnected', () => {
    expect(mapCloudflareHostnameStatus('pending_deletion')).toBe('disconnected');
    expect(mapCloudflareHostnameStatus('deleted')).toBe('disconnected');
  });

  it('maps blocked/failed-family statuses to failed', () => {
    expect(mapCloudflareHostnameStatus('blocked')).toBe('failed');
    expect(mapCloudflareHostnameStatus('pending_blocked')).toBe('failed');
    expect(mapCloudflareHostnameStatus('test_failed')).toBe('failed');
    expect(mapCloudflareHostnameStatus('moved')).toBe('failed');
  });

  it('maps a genuinely unrecognized Cloudflare status to failed — never to connected', () => {
    expect(mapCloudflareHostnameStatus('some_future_cloudflare_status')).toBe('failed');
  });
});

describe('mapCloudflareSslStatus', () => {
  it('maps active-family SSL statuses to active', () => {
    expect(mapCloudflareSslStatus('active')).toBe('active');
    expect(mapCloudflareSslStatus('staging_active')).toBe('active');
  });

  it('maps initializing/validation statuses to pending', () => {
    expect(mapCloudflareSslStatus('initializing')).toBe('pending');
    expect(mapCloudflareSslStatus('pending_validation')).toBe('pending');
  });

  it('maps issuance/deployment statuses to provisioning', () => {
    expect(mapCloudflareSslStatus('pending_issuance')).toBe('provisioning');
    expect(mapCloudflareSslStatus('pending_deployment')).toBe('provisioning');
  });

  it('maps expired to expired', () => {
    expect(mapCloudflareSslStatus('expired')).toBe('expired');
  });

  it('maps deleted/inactive-family statuses to not_configured', () => {
    expect(mapCloudflareSslStatus('deleted')).toBe('not_configured');
    expect(mapCloudflareSslStatus('inactive')).toBe('not_configured');
  });

  it('maps timeout-family statuses to failed', () => {
    expect(mapCloudflareSslStatus('validation_timed_out')).toBe('failed');
    expect(mapCloudflareSslStatus('deactivating')).toBe('failed');
  });

  it('maps a genuinely unrecognized SSL status to failed — never to active', () => {
    expect(mapCloudflareSslStatus('some_future_ssl_status')).toBe('failed');
  });
});

describe('mapCloudflareCdnStatus', () => {
  it('maps connected domain status to active CDN', () => {
    expect(mapCloudflareCdnStatus('connected')).toBe('active');
  });

  it('maps failed domain status to error CDN', () => {
    expect(mapCloudflareCdnStatus('failed')).toBe('error');
  });

  it('maps every other domain status to not_configured', () => {
    expect(mapCloudflareCdnStatus('verifying')).toBe('not_configured');
    expect(mapCloudflareCdnStatus('not_configured')).toBe('not_configured');
    expect(mapCloudflareCdnStatus('disconnected')).toBe('not_configured');
    expect(mapCloudflareCdnStatus('pending')).toBe('not_configured');
    expect(mapCloudflareCdnStatus('verification_required')).toBe('not_configured');
  });
});

describe('mapCloudflareCustomHostname', () => {
  function fixture(
    overrides: Partial<CloudflareCustomHostname> = {},
  ): CloudflareCustomHostname {
    return {
      id: 'ch_123',
      hostname: 'www.example.com',
      status: 'active',
      sslStatus: 'active',
      verificationRecords: [],
      ...overrides,
    };
  }

  it('composes all three mappers deterministically for a fully active hostname', () => {
    const result = mapCloudflareCustomHostname(fixture());
    expect(result).toEqual({
      status: 'connected',
      sslStatus: 'active',
      cdnStatus: 'active',
    });
  });

  it('composes correctly for a still-pending hostname', () => {
    const result = mapCloudflareCustomHostname(
      fixture({ status: 'pending', sslStatus: 'pending_validation' }),
    );
    expect(result).toEqual({
      status: 'verifying',
      sslStatus: 'pending',
      cdnStatus: 'not_configured',
    });
  });

  it('composes correctly for a blocked hostname', () => {
    const result = mapCloudflareCustomHostname(
      fixture({ status: 'blocked', sslStatus: 'deactivating' }),
    );
    expect(result).toEqual({ status: 'failed', sslStatus: 'failed', cdnStatus: 'error' });
  });

  it('is deterministic for identical input', () => {
    const input = fixture();
    expect(mapCloudflareCustomHostname(input)).toEqual(
      mapCloudflareCustomHostname(input),
    );
  });
});
