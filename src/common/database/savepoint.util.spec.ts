/**
 * `withSavepoint` unit spec — the STATEMENT SEQUENCE is the contract.
 *
 * The behaviour that matters (a poisoned transaction becoming usable
 * again) can only be proved against a real PostgreSQL, and is, in
 * `test/notifications.e2e-spec.ts` (N13/N14) and
 * `test/p64-comm-outbox.e2e-spec.ts`. What this spec pins down instead is
 * the part those e2e tests cannot see: that a CLEAN run releases its
 * savepoint rather than leaking one per loop iteration, that both
 * collision shapes (a throw, and a returned "collided" value) roll back,
 * and that a failing ROLLBACK never replaces the caller's own error with
 * the cleanup's.
 */
import { withSavepoint } from './savepoint.util';

type FakeTx = {
  $executeRawUnsafe: jest.Mock<Promise<number>, [string]>;
};

function fakeTx(): FakeTx {
  return { $executeRawUnsafe: jest.fn().mockResolvedValue(0) };
}

/** The savepoint name is random; assert on the verb, not the identifier. */
function verbs(tx: FakeTx): string[] {
  return tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql.replace(/"[^"]+"/, '<name>'));
}

describe('withSavepoint', () => {
  it('releases the savepoint when the work succeeds and did not collide', async () => {
    const tx = fakeTx();
    const result = await withSavepoint(tx as never, async () => 'ok');

    expect(result).toBe('ok');
    expect(verbs(tx)).toEqual(['SAVEPOINT <name>', 'RELEASE SAVEPOINT <name>']);
  });

  it('rolls back when the work reports that it collided, and still returns its value', async () => {
    const tx = fakeTx();
    const result = await withSavepoint(tx as never, async () => false, {
      collided: (created) => created === false,
    });

    expect(result).toBe(false);
    expect(verbs(tx)).toEqual(['SAVEPOINT <name>', 'ROLLBACK TO SAVEPOINT <name>']);
  });

  it('rolls back and rethrows when the work throws', async () => {
    const tx = fakeTx();
    const boom = new Error('unique violation');

    await expect(
      withSavepoint(tx as never, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(verbs(tx)).toEqual(['SAVEPOINT <name>', 'ROLLBACK TO SAVEPOINT <name>']);
  });

  it('treats a returned value as success unless `collided` says otherwise', async () => {
    const tx = fakeTx();
    await withSavepoint(tx as never, async () => false);
    expect(verbs(tx)).toEqual(['SAVEPOINT <name>', 'RELEASE SAVEPOINT <name>']);
  });

  it('never masks the work’s own error with a failing rollback', async () => {
    const tx = fakeTx();
    const boom = new Error('the real failure');
    const cleanupFailure = new Error('rollback itself failed');
    tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql.startsWith('ROLLBACK')) throw cleanupFailure;
      return 0;
    });
    const seen: unknown[] = [];

    await expect(
      withSavepoint(
        tx as never,
        async () => {
          throw boom;
        },
        { onCleanupError: (error) => seen.push(error) },
      ),
    ).rejects.toBe(boom);
    expect(seen).toEqual([cleanupFailure]);
  });

  it('uses a fresh name each time, so nesting can never reuse one', async () => {
    const tx = fakeTx();
    await withSavepoint(tx as never, () => withSavepoint(tx as never, async () => 'ok'));

    const names = tx.$executeRawUnsafe.mock.calls
      .map(([sql]) => /"([^"]+)"/.exec(sql)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(new Set(names).size).toBe(2);
    expect(verbs(tx)).toEqual([
      'SAVEPOINT <name>',
      'SAVEPOINT <name>',
      'RELEASE SAVEPOINT <name>',
      'RELEASE SAVEPOINT <name>',
    ]);
  });
});
