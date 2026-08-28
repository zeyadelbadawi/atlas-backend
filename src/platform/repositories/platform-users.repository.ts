/**
 * PlatformUsersRepository — `users` carries no RLS at all (identity is
 * not tenant-scoped; confirmed directly against every migration — no
 * `ALTER TABLE "users" ENABLE ROW LEVEL SECURITY` exists anywhere), so
 * this repository uses the raw `PrismaService` directly, matching
 * `UsersRepository`'s (P1) own established precedent for this one table.
 * `PlatformOwnerGuard` at the controller is the real, sufficient
 * authorization boundary for the cross-tenant reach this grants — the
 * SAME boundary `UsersRepository` itself already relies on implicitly
 * (it has always been globally queryable by any authenticated backend
 * code path; nothing this phase adds widens that).
 *
 * The `select` clause below is the real, enforced "never expose
 * `passwordHash`/tokens" boundary — not merely the response DTO's own
 * field list, which would still be a defense-in-depth gap if the ORM
 * query itself over-fetched. Every column selected here is one
 * `PlatformUserSummary`/`.Detail` (frontend contract) actually needs.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
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
      this.prisma.user.findMany({
        where,
        select: SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, totalItems };
  }

  findById(id: string): Promise<PlatformUserRow | null> {
    return this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
  }
}
