import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlatformDomainService } from './platform-domain.service';

function build(
  envBaseDomain: string | undefined,
  row: { baseDomain: string | null; configured: boolean },
) {
  const repository = {
    findSingleton: jest.fn().mockResolvedValue({
      id: 'singleton',
      baseDomain: row.baseDomain,
      configured: row.configured,
      updatedAt: new Date('2026-09-16T00:00:00Z'),
    }),
    update: jest.fn().mockImplementation(async (baseDomain: string) => ({
      id: 'singleton',
      baseDomain,
      configured: true,
      updatedAt: new Date('2026-09-16T00:00:00Z'),
    })),
  };
  const probe = {
    probe: jest.fn().mockResolvedValue({ reachable: true, checkedAt: new Date() }),
  };
  const cloudflare = {
    verifyToken: jest.fn().mockResolvedValue(true),
    getFallbackOrigin: jest
      .fn()
      .mockResolvedValue({ origin: 'Customers.Atlas.dev', status: 'active' }),
    getZoneSslMode: jest.fn().mockResolvedValue('full'),
  };
  const config = {
    get: jest.fn().mockReturnValue({ baseDomain: envBaseDomain }),
  } as unknown as ConfigService;
  const service = new PlatformDomainService(
    repository as never,
    probe as never,
    cloudflare as never,
    config,
  );
  return { service, repository, probe, cloudflare };
}

describe('PlatformDomainService (P63) — one source of truth for the base domain', () => {
  it('the deployment environment wins over the database row', async () => {
    const { service } = build('Atlass.dpdns.org', {
      baseDomain: 'stale.example',
      configured: true,
    });
    await expect(service.getEffectiveBaseDomain()).resolves.toEqual({
      baseDomain: 'atlass.dpdns.org',
      source: 'environment',
    });
    const configuration = await service.getPlatformDomainConfiguration();
    expect(configuration).toMatchObject({
      baseDomain: 'atlass.dpdns.org',
      configured: true,
      source: 'environment',
    });
  });

  it('falls back to the database row only when the environment is silent', async () => {
    const { service } = build(undefined, { baseDomain: 'Db.Example', configured: true });
    await expect(service.getEffectiveBaseDomain()).resolves.toEqual({
      baseDomain: 'db.example',
      source: 'database',
    });
  });

  it('is honestly unconfigured when neither exists', async () => {
    const { service } = build(undefined, { baseDomain: null, configured: false });
    await expect(service.getEffectiveBaseDomain()).resolves.toEqual({});
    await expect(service.getPlatformDomainConfiguration()).resolves.toMatchObject({
      configured: false,
    });
  });

  it('refuses a database edit while the environment owns the value (409 concurrency-shaped conflict)', async () => {
    const { service, repository } = build('atlass.dpdns.org', {
      baseDomain: null,
      configured: false,
    });
    await expect(
      service.updatePlatformDomainConfiguration('other.example'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('allows the database edit when the environment is silent', async () => {
    const { service, repository } = build(undefined, {
      baseDomain: null,
      configured: false,
    });
    await expect(
      service.updatePlatformDomainConfiguration('new.example'),
    ).resolves.toMatchObject({
      baseDomain: 'new.example',
      configured: true,
      source: 'database',
    });
    expect(repository.update).toHaveBeenCalledWith('new.example');
  });

  it('the CNAME target is the zone fallback origin, lower-cased, or null when none exists', async () => {
    const { service, cloudflare } = build('atlass.dpdns.org', {
      baseDomain: null,
      configured: false,
    });
    await expect(service.getCnameTarget()).resolves.toBe('customers.atlas.dev');
    // Cached: a second read does not ask the provider again.
    await expect(service.getCnameTarget()).resolves.toBe('customers.atlas.dev');
    expect(cloudflare.getFallbackOrigin).toHaveBeenCalledTimes(1);
    // Readiness always asks live and refreshes what the customer tab sees.
    cloudflare.getFallbackOrigin.mockResolvedValueOnce(null);
    await service.getReadiness();
    await expect(service.getCnameTarget()).resolves.toBeNull();
  });

  it('readiness reports live provider facts and probes, and never invents a fallback origin', async () => {
    const { service, cloudflare, probe } = build('atlass.dpdns.org', {
      baseDomain: null,
      configured: false,
    });
    const readiness = await service.getReadiness();
    expect(readiness.customHostnames).toMatchObject({
      ready: true,
      fallbackOrigin: 'Customers.Atlas.dev',
      originSslMode: 'full',
      originSslModeCompatible: true,
    });
    expect(readiness.platformHttps).toMatchObject({
      baseDomainReachable: true,
      wildcardReachable: true,
    });
    expect(probe).toHaveProperty('probe');
    expect(probe.probe).toHaveBeenCalledWith('atlass.dpdns.org');
    expect(probe.probe).toHaveBeenCalledWith('atlas-wildcard-probe.atlass.dpdns.org');

    cloudflare.getFallbackOrigin.mockResolvedValueOnce(null);
    cloudflare.getZoneSslMode.mockResolvedValueOnce('strict');
    const notReady = await service.getReadiness();
    expect(notReady.customHostnames).toMatchObject({
      ready: false,
      originSslModeCompatible: false,
    });
    expect(notReady.customHostnames.fallbackOrigin).toBeUndefined();
  });
});
