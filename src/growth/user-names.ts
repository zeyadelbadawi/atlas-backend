import type { Prisma } from '@prisma/client';

/** Display names for the given user ids (unknown or deleted ids are simply absent). */
export async function userNames(
  tx: Prisma.TransactionClient,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const users = await tx.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}
