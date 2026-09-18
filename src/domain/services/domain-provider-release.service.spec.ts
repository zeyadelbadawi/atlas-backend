/**
 * P63g — the release ledger's safety rules, with an in-memory provider.
 */
import { DomainProviderReleaseService } from './domain-provider-release.service';
import { domainCheckBackoffMs } from '../constants/domain.constants';
import {
  buildFullHost,
  resolveEffectiveBaseDomain,
} from '../utils/effective-base-domain.util';
import { releaseRetryDelayMs } from '../repositories/domain-provider-releases.repository';

function build(opts: {
  resourceById?: { id: string; hostname: string } | null;
  deleteOutcome?: 'deleted' | 'not_found' | 'failed';
  currentRow?: { providerHostnameId: string | null } | null;
  lookupThrows?: boolean;
}) {
  const releases = {
    markReleased: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    findDue: jest.fn().mockResolvedValue([]),
  };
  const connections = {
    findByHostname: jest.fn().mockResolvedValue(opts.currentRow ?? null),
  };
  const provider = {
    getCustomHostnameById: jest.fn(async () => {
      if (opts.lookupThrows) throw new Error('boom');
      return opts.resourceById ?? null;
    }),
    getCustomHostnameByHostname: jest.fn().mockResolvedValue(null),
    deleteCustomHostname: jest.fn().mockResolvedValue(opts.deleteOutcome ?? 'deleted'),
  };
  const service = new DomainProviderReleaseService(
    releases as never,
    connections as never,
    provider as never,
  );
  return { service, releases, provider };
}

const row = {
  id: 'rel_1',
  academyId: 'a',
  hostname: 'learn.example.com',
  providerHostnameId: 'cfh_1',
  reason: 'replaced',
  attempts: 0,
  lastAttemptedAt: null,
  lastError: null,
  releasedAt: null,
  outcome: null,
  createdAt: new Date(),
};

describe('DomainProviderReleaseService (P63g)', () => {
  it('deletes the resource when it still carries the released hostname', async () => {
    const { service, provider, releases } = build({
      resourceById: { id: 'cfh_1', hostname: 'learn.example.com' },
    });
    await expect(service.attempt({} as never, row as never, true)).resolves.toEqual({
      kind: 'released',
      outcome: 'deleted',
    });
    expect(provider.deleteCustomHostname).toHaveBeenCalledWith('cfh_1');
    expect(releases.markReleased).toHaveBeenCalledWith(
      {},
      'rel_1',
      'deleted',
      expect.any(Date),
    );
  });

  it('never deletes a resource that now answers for another hostname', async () => {
    const { service, provider } = build({
      resourceById: { id: 'cfh_1', hostname: 'other.example.com' },
    });
    const result = await service.attempt({} as never, row as never, true);
    expect(result).toEqual({ kind: 'released', outcome: 'not_found' });
    expect(provider.deleteCustomHostname).not.toHaveBeenCalled();
  });

  it('never deletes a resource an Atlas row has adopted again (same hostname, same id)', async () => {
    const { service, provider } = build({ currentRow: { providerHostnameId: 'cfh_1' } });
    await expect(service.attempt({} as never, row as never, true)).resolves.toEqual({
      kind: 'released',
      outcome: 'reassigned',
    });
    expect(provider.getCustomHostnameById).not.toHaveBeenCalled();
    expect(provider.deleteCustomHostname).not.toHaveBeenCalled();
  });

  it('records a failed delete for retry instead of forgetting it', async () => {
    const { service, releases } = build({
      resourceById: { id: 'cfh_1', hostname: 'learn.example.com' },
      deleteOutcome: 'failed',
    });
    await expect(service.attempt({} as never, row as never, true)).resolves.toEqual({
      kind: 'failed',
      error: 'provider_error',
    });
    expect(releases.markFailed).toHaveBeenCalledWith(
      {},
      'rel_1',
      'provider_error',
      expect.any(Date),
    );
  });

  it('records provider_unavailable without touching the provider when the token is not valid', async () => {
    const { service, provider, releases } = build({});
    await expect(service.attempt({} as never, row as never, false)).resolves.toEqual({
      kind: 'failed',
      error: 'provider_unavailable',
    });
    expect(provider.getCustomHostnameById).not.toHaveBeenCalled();
    expect(releases.markFailed).toHaveBeenCalled();
  });

  it('a lookup failure is retried later, never treated as gone', async () => {
    const { service, releases } = build({ lookupThrows: true });
    await expect(service.attempt({} as never, row as never, true)).resolves.toEqual({
      kind: 'failed',
      error: 'provider_error',
    });
    expect(releases.markReleased).not.toHaveBeenCalled();
  });
});

describe('backoff and base-domain helpers (P63g)', () => {
  it('check backoff stays on the fast cadence for the first retries, then doubles to a daily cap', () => {
    expect(domainCheckBackoffMs(0)).toBe(5 * 60 * 1000);
    expect(domainCheckBackoffMs(3)).toBe(5 * 60 * 1000);
    expect(domainCheckBackoffMs(4)).toBe(10 * 60 * 1000);
    expect(domainCheckBackoffMs(6)).toBe(40 * 60 * 1000);
    expect(domainCheckBackoffMs(50)).toBe(24 * 60 * 60 * 1000);
  });

  it('release retries double from a minute and cap at six hours, never giving up', () => {
    expect(releaseRetryDelayMs(0)).toBe(60_000);
    expect(releaseRetryDelayMs(3)).toBe(8 * 60_000);
    expect(releaseRetryDelayMs(40)).toBe(6 * 60 * 60 * 1000);
  });

  it('the effective base domain is the environment, else the configured row, else nothing', () => {
    expect(
      resolveEffectiveBaseDomain(' Atlas.Dev ', {
        baseDomain: 'other.dev',
        configured: true,
      }),
    ).toEqual({ baseDomain: 'atlas.dev', source: 'environment' });
    expect(
      resolveEffectiveBaseDomain(undefined, {
        baseDomain: 'Db.Example',
        configured: true,
      }),
    ).toEqual({ baseDomain: 'db.example', source: 'database' });
    expect(
      resolveEffectiveBaseDomain(undefined, {
        baseDomain: 'db.example',
        configured: false,
      }),
    ).toEqual({});
    expect(buildFullHost('Harvard', 'atlas.dev')).toBe('harvard.atlas.dev');
    expect(buildFullHost('harvard', undefined)).toBeNull();
  });
});
