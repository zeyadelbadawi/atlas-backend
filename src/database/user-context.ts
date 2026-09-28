/**
 * The one implementation of "run this work in a user's RLS context":
 * `app.current_user_id` set with `set_config(..., true)` for exactly one
 * transaction. `TenancyContextService.runInUserContext` delegates here; the
 * identity repositories call it directly because `AuthCoreModule` (which
 * provides them to the JWT guard) cannot import `TenancyModule` without a
 * cycle.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

const transactionOptions = {
  timeout: Number(process.env.PRISMA_INTERACTIVE_TX_TIMEOUT_MS ?? 5000),
  maxWait: Number(process.env.PRISMA_INTERACTIVE_TX_MAX_WAIT_MS ?? 2000),
};

export function runInUserContext<T>(
  prisma: PrismaClient,
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return work(tx);
  }, transactionOptions);
}
