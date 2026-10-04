/**
 * `findManagingRole` — the service-level twin of `AcademyScopeGuard`'s
 * rule: an active managing staff row, else the organization OWNER (never an
 * organization manager or member), else nothing.
 */
import type { Prisma } from '@prisma/client';
import { AcademyMembersRepository } from './academy-members.repository';

const MANAGING = new Set(['owner', 'administrator', 'manager']);

function fakeTx(options: {
  readonly staffRole?: string;
  readonly organizationRole?: string;
}): Prisma.TransactionClient {
  return {
    academyMember: {
      findFirst: jest.fn(async () =>
        options.staffRole ? { role: options.staffRole, status: 'active' } : null,
      ),
    },
    academy: {
      findUnique: jest.fn(async () => ({ organizationId: 'org-1' })),
    },
    organizationMembership: {
      findFirst: jest.fn(async ({ where }: { where: { role: string } }) =>
        options.organizationRole === where.role ? { id: 'm-1' } : null,
      ),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('AcademyMembersRepository.findManagingRole', () => {
  const repository = new AcademyMembersRepository();

  it('returns the managing staff role of an active row', async () => {
    await expect(
      repository.findManagingRole(fakeTx({ staffRole: 'manager' }), 'a', 'u', MANAGING),
    ).resolves.toBe('manager');
  });

  it('treats the organization owner as academy owner without a staff row', async () => {
    await expect(
      repository.findManagingRole(
        fakeTx({ organizationRole: 'owner' }),
        'a',
        'u',
        MANAGING,
      ),
    ).resolves.toBe('owner');
  });

  it('lifts an organization owner whose staff row is only instructor to owner', async () => {
    await expect(
      repository.findManagingRole(
        fakeTx({ staffRole: 'instructor', organizationRole: 'owner' }),
        'a',
        'u',
        MANAGING,
      ),
    ).resolves.toBe('owner');
  });

  it('gives an organization manager nothing without a managing staff row', async () => {
    await expect(
      repository.findManagingRole(
        fakeTx({ organizationRole: 'manager' }),
        'a',
        'u',
        MANAGING,
      ),
    ).resolves.toBeNull();
    await expect(
      repository.findManagingRole(
        fakeTx({ staffRole: 'instructor', organizationRole: 'manager' }),
        'a',
        'u',
        MANAGING,
      ),
    ).resolves.toBeNull();
  });

  it('never applies the owner rule to a tier that excludes owner', async () => {
    await expect(
      repository.findManagingRole(
        fakeTx({ organizationRole: 'owner' }),
        'a',
        'u',
        new Set(['manager']),
      ),
    ).resolves.toBeNull();
  });
});
