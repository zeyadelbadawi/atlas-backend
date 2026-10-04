/**
 * W4 — `OrganizationsService.createInTransaction`: a name already held is a
 * generic 409 before any insert, and an unnamed P2002 that turns out to be
 * the NAME is never retried as a slug collision (five retries used to end
 * in a raw P2002 and a 500).
 */
import { Prisma } from '@prisma/client';
import { OrganizationsService } from './organizations.service';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function setup(queryAnswers: unknown[][], createOutcomes: Array<'ok' | 'p2002'>) {
  const tx = {
    $queryRaw: jest.fn(async () => queryAnswers.shift() ?? [{ taken: false }]),
    $executeRaw: jest.fn(async () => 0),
    $executeRawUnsafe: jest.fn(async () => 0),
  };
  const organizationsRepository = {
    create: jest.fn(async (_tx: unknown, data: Record<string, unknown>) => {
      if ((createOutcomes.shift() ?? 'ok') === 'p2002') throw p2002();
      return { ...data };
    }),
  };
  const memberships = {
    clearPrimaryForUser: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
  };
  const audit = { write: jest.fn(async () => undefined) };
  const service = new OrganizationsService(
    {} as never,
    organizationsRepository as never,
    memberships as never,
    audit as never,
  );
  return { service, tx, organizationsRepository };
}

const INPUT = { organizationId: 'o1', userId: 'u1', name: '  Acme  Academy ' };

describe('OrganizationsService.createInTransaction (W4)', () => {
  it('refuses a taken name with the generic key, before inserting', async () => {
    const { service, tx, organizationsRepository } = setup(
      [[{ key: 'acme academy' }], [{ taken: true }]],
      [],
    );
    await expect(
      service.createInTransaction(tx as never, {
        ...INPUT,
        nameField: 'organizationName',
      }),
    ).rejects.toMatchObject({
      response: {
        messageKey: 'errors.organization.nameUnavailable',
        violations: [{ field: 'organizationName' }],
      },
    });
    expect(organizationsRepository.create).not.toHaveBeenCalled();
  });

  it('a P2002 classified as the name is a 409, not five slug retries', async () => {
    const { service, tx, organizationsRepository } = setup(
      [[{ key: 'acme academy' }], [{ taken: false }], [{ taken: true }]],
      ['p2002'],
    );
    await expect(service.createInTransaction(tx as never, INPUT)).rejects.toMatchObject({
      response: { messageKey: 'errors.organization.nameUnavailable' },
    });
    expect(organizationsRepository.create).toHaveBeenCalledTimes(1);
  });

  it('a P2002 that is not the name is still a slug retry, and the name is cleaned', async () => {
    const { service, tx, organizationsRepository } = setup(
      [[{ key: 'acme academy' }], [{ taken: false }], [{ taken: false }]],
      ['p2002', 'ok'],
    );
    const created = await service.createInTransaction(tx as never, INPUT);
    expect(organizationsRepository.create).toHaveBeenCalledTimes(2);
    expect(created.name).toBe('Acme Academy');
    const slugs = organizationsRepository.create.mock.calls.map(
      (call) => (call[1] as { slug: string }).slug,
    );
    expect(slugs[0]).toBe('acme-academy');
    expect(slugs[1]).toMatch(/^acme-academy-/);
  });

  it('a name with nothing comparable is a 400', async () => {
    const { service, tx } = setup([[{ key: '' }]], []);
    await expect(service.createInTransaction(tx as never, INPUT)).rejects.toMatchObject({
      response: { messageKey: 'errors.validation.nameInvalid' },
    });
  });
});
