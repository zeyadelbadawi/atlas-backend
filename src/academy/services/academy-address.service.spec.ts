/**
 * Slug change → the public address moves and the old one is kept as a
 * redirect (owner decision, 20 Oct 2026). Repositories are in-memory fakes:
 * what is pinned here is the move itself — which rows change, which label
 * is kept, how an old address is taken back. RLS and the namespace
 * triggers are covered by `test/academy-address-change.e2e-spec.ts`.
 */
import type { SubdomainAlias, SubdomainAllocation } from '@prisma/client';
import { AcademyAddressService } from './academy-address.service';

const ACADEMY_ID = 'academy-1';
const BASE = 'atlas.example';
const tx = { marker: 'tx' } as never;

function build(
  options: {
    allocation?: string | null;
    aliases?: string[];
  } = {},
) {
  const { allocation = 'nour', aliases = [] } = options;
  let allocationRow: SubdomainAllocation | null =
    allocation === null
      ? null
      : ({
          id: 'allocation-1',
          academyId: ACADEMY_ID,
          subdomain: allocation,
          status: 'assigned',
          fullHost: `${allocation}.${BASE}`,
        } as SubdomainAllocation);
  let aliasRows: SubdomainAlias[] = aliases.map(
    (subdomain, index) =>
      ({ id: `alias-${index + 1}`, academyId: ACADEMY_ID, subdomain }) as SubdomainAlias,
  );
  let nextAlias = aliasRows.length + 1;

  const allocations = {
    findByAcademyId: jest.fn(async () => allocationRow),
    moveTo: jest.fn(
      async (
        _tx: unknown,
        _academyId: string,
        data: { subdomain: string; fullHost: string | null },
      ) => {
        allocationRow = { ...(allocationRow as SubdomainAllocation), ...data };
        return allocationRow;
      },
    ),
    create: jest.fn(async (_tx: unknown, data: Record<string, unknown>) => {
      allocationRow = { id: 'allocation-new', ...data } as SubdomainAllocation;
      return allocationRow;
    }),
  };
  const aliasesRepository = {
    findForAcademy: jest.fn(
      async (_tx: unknown, academyId: string, subdomain: string) =>
        aliasRows.find(
          (row) => row.academyId === academyId && row.subdomain === subdomain,
        ) ?? null,
    ),
    findAllForAcademy: jest.fn(async () => aliasRows),
    create: jest.fn(
      async (_tx: unknown, data: { academyId: string; subdomain: string }) => {
        const row = { id: `alias-${nextAlias++}`, ...data } as SubdomainAlias;
        aliasRows = [...aliasRows, row];
        return row;
      },
    ),
    rename: jest.fn(async (_tx: unknown, id: string, subdomain: string) => {
      aliasRows = aliasRows.map((row) => (row.id === id ? { ...row, subdomain } : row));
      return aliasRows.find((row) => row.id === id) as SubdomainAlias;
    }),
  };

  const service = new AcademyAddressService(
    allocations as never,
    aliasesRepository as never,
  );
  return {
    service,
    allocations,
    aliasesRepository,
    labels: () => aliasRows.map((row) => row.subdomain).sort(),
    allocation: () => allocationRow,
  };
}

describe('AcademyAddressService.move', () => {
  it('moves the allocation and its full host, and keeps the old label as a redirect', async () => {
    const { service, allocations, aliasesRepository, labels } = build();

    const result = await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour-academy',
      baseDomain: BASE,
    });

    expect(allocations.moveTo).toHaveBeenCalledWith(tx, ACADEMY_ID, {
      subdomain: 'nour-academy',
      fullHost: `nour-academy.${BASE}`,
    });
    expect(aliasesRepository.create).toHaveBeenCalledWith(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour',
    });
    expect(result).toMatchObject({
      previous: { subdomain: 'nour', fullHost: `nour.${BASE}` },
      allocation: { subdomain: 'nour-academy', fullHost: `nour-academy.${BASE}` },
      redirectKept: true,
      reclaimedAlias: false,
      aliases: ['nour'],
    });
    expect(labels()).toEqual(['nour']);
  });

  it('records no full host when no base domain is in force (same rule as creation)', async () => {
    const { service, allocations } = build();

    await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour-academy',
      baseDomain: undefined,
    });

    expect(allocations.moveTo).toHaveBeenCalledWith(tx, ACADEMY_ID, {
      subdomain: 'nour-academy',
      fullHost: null,
    });
  });

  it('takes an old address back: the alias row now holds the label given up', async () => {
    const { service, aliasesRepository, labels, allocation } = build({
      allocation: 'nour-academy',
      aliases: ['nour'],
    });

    const result = await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour',
      baseDomain: BASE,
    });

    expect(allocation()?.subdomain).toBe('nour');
    expect(aliasesRepository.rename).toHaveBeenCalledWith(tx, 'alias-1', 'nour-academy');
    expect(aliasesRepository.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ redirectKept: true, reclaimedAlias: true });
    expect(labels()).toEqual(['nour-academy']);
  });

  it('keeps every earlier address across several changes', async () => {
    const { service, labels, allocation } = build({ allocation: 'one' });

    await service.move(tx, { academyId: ACADEMY_ID, subdomain: 'two', baseDomain: BASE });
    await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'three',
      baseDomain: BASE,
    });

    expect(allocation()?.subdomain).toBe('three');
    expect(labels()).toEqual(['one', 'two']);
  });

  it('gives a reserved old label back to the platform instead of keeping it', async () => {
    // An academy that held `docs…` before DL-57 reserved it.
    const { service, aliasesRepository } = build({ allocation: 'docs' });

    const result = await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour-academy',
      baseDomain: BASE,
    });

    expect(aliasesRepository.create).not.toHaveBeenCalled();
    expect(aliasesRepository.rename).not.toHaveBeenCalled();
    expect(result.redirectKept).toBe(false);
  });

  it('creates the allocation for an academy that never had one', async () => {
    const { service, allocations, aliasesRepository } = build({ allocation: null });

    const result = await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour-academy',
      baseDomain: BASE,
    });

    expect(allocations.create).toHaveBeenCalledWith(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour-academy',
      status: 'assigned',
      fullHost: `nour-academy.${BASE}`,
    });
    expect(aliasesRepository.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ previous: null, redirectKept: false });
  });

  it('changes nothing when the allocation already carries the new label', async () => {
    const { service, allocations, aliasesRepository } = build({ allocation: 'nour' });

    const result = await service.move(tx, {
      academyId: ACADEMY_ID,
      subdomain: 'nour',
      baseDomain: BASE,
    });

    expect(allocations.moveTo).not.toHaveBeenCalled();
    expect(allocations.create).not.toHaveBeenCalled();
    expect(aliasesRepository.create).not.toHaveBeenCalled();
    expect(result.redirectKept).toBe(false);
  });
});
