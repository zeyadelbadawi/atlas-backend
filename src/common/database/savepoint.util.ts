/**
 * `withSavepoint` — run one statement that is ALLOWED to fail inside a
 * PostgreSQL SAVEPOINT, so that swallowing its error leaves the caller's
 * transaction usable.
 *
 * This exists because "catch the unique violation and report it as
 * `false`" is only half of an idempotent insert. In PostgreSQL a failed
 * statement ABORTS the enclosing transaction: every statement after it,
 * INCLUDING the caller's own unrelated business writes and the eventual
 * COMMIT, then fails with `current transaction is aborted, commands
 * ignored until end of transaction block`, and the COMMIT is silently
 * downgraded to a ROLLBACK. A repository that returns `false` on a
 * duplicate without a savepoint is therefore handing its caller a
 * transaction that can no longer do anything — the caller sees the
 * dedupe as a clean no-op and loses every write it had already made.
 *
 * `ROLLBACK TO SAVEPOINT` is the one statement Postgres accepts in an
 * aborted transaction, and it restores the transaction to exactly the
 * state it had before the guarded statement ran.
 *
 * Two collision shapes are handled, because the two matter equally:
 *   - the work THROWS (the caller wants the error to propagate, but with
 *     a still-usable transaction — e.g. to report it and carry on);
 *   - the work RETURNS a value that means "collided" (the repository
 *     already swallowed the violation itself), reported via `collided`.
 * Both roll back to the savepoint; a clean run releases it, so a long
 * loop does not accumulate savepoints.
 *
 * Callers should skip this wrapper entirely when a collision is
 * impossible (a NULL dedupe key, say): it costs two extra round-trips.
 */
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export interface SavepointOptions<T> {
  /**
   * Returns `true` when the work's own RETURN value means it collided and
   * swallowed the database error itself. Default: a returned value never
   * means a collision (only a throw does).
   */
  readonly collided?: (result: T) => boolean;
  /**
   * Called when the ROLLBACK itself fails — the transaction is then
   * unrecoverable and the caller's own error, if any, must still win.
   * Never throws from inside the cleanup path.
   */
  readonly onCleanupError?: (error: unknown) => void;
}

export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  work: () => Promise<T>,
  options: SavepointOptions<T> = {},
): Promise<T> {
  // An identifier, never a bound parameter — Postgres does not accept a
  // parameter for a savepoint name. Hex from `randomUUID`, so nothing a
  // caller controls ever reaches the statement text and nesting can
  // never reuse a name.
  const name = `sp_${randomUUID().replace(/-/g, '')}`;
  await tx.$executeRawUnsafe(`SAVEPOINT "${name}"`);

  let result: T;
  try {
    result = await work();
  } catch (error) {
    await releaseOrRollback(tx, name, true, options.onCleanupError);
    throw error;
  }

  const didCollide = options.collided?.(result) ?? false;
  await releaseOrRollback(tx, name, didCollide, options.onCleanupError);
  return result;
}

async function releaseOrRollback(
  tx: Prisma.TransactionClient,
  name: string,
  rollback: boolean,
  onCleanupError?: (error: unknown) => void,
): Promise<void> {
  try {
    await tx.$executeRawUnsafe(
      rollback ? `ROLLBACK TO SAVEPOINT "${name}"` : `RELEASE SAVEPOINT "${name}"`,
    );
  } catch (error) {
    // Never mask the original failure with the cleanup's own.
    onCleanupError?.(error);
  }
}
