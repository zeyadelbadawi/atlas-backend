/**
 * PlatformUsersRepository — the Platform Owner's cross-tenant user list.
 *
 * `users` carries FORCE ROW LEVEL SECURITY (authentication audit,
 * Decision 2): rows are readable only inside an established context. Every
 * method therefore takes the transaction the service opened in the Platform
 * Owner's own context; `PlatformOwnerGuard` at the controller remains the
 * authorization boundary for the cross-tenant reach.
 *
 * The `select` clause below is the real, enforced "never expose
 * `passwordHash`/tokens" boundary — not merely the response DTO's own
 * field list, which would still be a defense-in-depth gap if the ORM
 * query itself over-fetched. Every column selected here is one
 * `PlatformUserSummary`/`.Detail` (frontend contract) actually needs.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PlatformUserRow } from '../dto/platform-user.contract';

const SAFE_SELECT = {
  id: true,
  name: true,
  email: true,
  status: true,
  isPlatformOwner: true,
  createdAt: true,
  lastSignInAt: true,
} as const;

export interface PlatformUserListFilter {
  readonly search?: string;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class PlatformUsersRepository {
  async findMany(
    tx: Prisma.TransactionClient,
    filter: PlatformUserListFilter,
  ): Promise<{ items: PlatformUserRow[]; totalItems: number }> {
    const where: Prisma.UserWhereInput = filter.search
      ? {
          OR: [
            { name: { contains: filter.search, mode: 'insensitive' as const } },
            { email: { contains: filter.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [items, totalItems] = await Promise.all([
      tx.user.findMany({
        where,
        select: SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.user.count({ where }),
    ]);

    return { items, totalItems };
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<PlatformUserRow | null> {
    return tx.user.findUnique({ where: { id }, select: SAFE_SELECT });
  }
}
