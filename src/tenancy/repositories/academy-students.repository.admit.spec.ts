/**
 * W4 — `AcademyStudentsRepository.admit`: the learner-name policy and the
 * classification of an unnamed unique violation (under FORCE RLS a P2002
 * carries no target, so the definer check is asked again in the savepoint).
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcademyStudentsRepository } from './academy-students.repository';

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: '(not available)' },
  });
}

function fakeTx(takenAnswers: boolean[], createResults: Array<'ok' | 'p2002'>) {
  const statements: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: jest.fn(async () => [{ taken: takenAnswers.shift() ?? false }]),
    $executeRaw: jest.fn(async () => 0),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      statements.push(sql.split(' ')[0] === 'ROLLBACK' ? 'ROLLBACK' : sql.split(' ')[0]);
      return 0;
    }),
    academyStudent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const next = createResults.shift() ?? 'ok';
        if (next === 'p2002') throw p2002();
        created.push(data);
        return { id: 'row', ...data };
      }),
    },
  };
  return { tx, statements, created };
}

const DATA = { academyId: 'a1', userId: 'u1', source: 'self_signup' as const };

describe('AcademyStudentsRepository.admit (W4)', () => {
  const repository = new AcademyStudentsRepository({} as never);

  it('interactive: a taken name is a 409 on the requested field, nothing inserted', async () => {
    const { tx, created } = fakeTx([true], []);
    await expect(
      repository.admit(tx as never, DATA, {
        mode: 'interactive',
        field: 'email',
        variant: 'existingAccount',
      }),
    ).rejects.toMatchObject({
      response: {
        messageKey: 'errors.academy.learnerNameTakenExistingAccount',
        violations: [{ field: 'email' }],
      },
    });
    expect(created).toHaveLength(0);
  });

  it('automatic: a taken name never fails — the row is inserted exempt', async () => {
    const { tx, created } = fakeTx([true], ['ok']);
    const result = await repository.admit(tx as never, DATA, { mode: 'automatic' });
    expect(result.nameClashExempted).toBe(true);
    expect(created[0]).toMatchObject({ nameUniqueExempt: true });
  });

  it('a free name inserts a normal row inside a savepoint', async () => {
    const { tx, created, statements } = fakeTx([false], ['ok']);
    const result = await repository.admit(tx as never, DATA, { mode: 'interactive' });
    expect(result.nameClashExempted).toBe(false);
    expect(created[0]).toMatchObject({ nameUniqueExempt: false });
    expect(statements).toEqual(['SAVEPOINT', 'RELEASE']);
  });

  it('classifies an unnamed P2002 as a NAME clash by asking again (interactive → 409)', async () => {
    const { tx, statements } = fakeTx([false, true], ['p2002']);
    await expect(
      repository.admit(tx as never, DATA, { mode: 'interactive' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(statements).toEqual(['SAVEPOINT', 'ROLLBACK']);
  });

  it('classifies an unnamed P2002 as a NAME clash (automatic → retried exempt)', async () => {
    const { tx, created } = fakeTx([false, true], ['p2002', 'ok']);
    const result = await repository.admit(tx as never, DATA, { mode: 'automatic' });
    expect(result.nameClashExempted).toBe(true);
    expect(created[0]).toMatchObject({ nameUniqueExempt: true });
  });

  it('rethrows a P2002 that is NOT the name (the (academy, user) index) unchanged', async () => {
    const { tx } = fakeTx([false, false], ['p2002']);
    await expect(
      repository.admit(tx as never, DATA, { mode: 'interactive' }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
