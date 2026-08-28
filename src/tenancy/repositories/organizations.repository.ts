/**
 * OrganizationsRepository — see `OrganizationMembershipsRepository`'s doc
 * comment: every method takes a `Prisma.TransactionClient` obtained from
 * `TenancyContextService`, never the raw `PrismaService`.
 */
import { Injectable } from '@nestjs/common';
import type { Organization, Prisma, User } from '@prisma/client';

export type OrganizationWithCounts = Organization & {
  _count: { academies: number; memberships: number };
};

export type OrganizationWithOwnerAndCounts = OrganizationWithCounts & {
  owner: Pick<User, 'id' | 'name' | 'email'>;
};

@Injectable()
export class OrganizationsRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { id } });
  }

  /** All organizations RLS currently permits — meaningful only inside `runInUserContext` (see that method's doc comment), where it resolves to exactly the organizations the given user belongs to. */
  findAllVisible(tx: Prisma.TransactionClient): Promise<Organization[]> {
    return tx.organization.findMany();
  }

  /**
   * Phase P15 — the Platform Owner's cross-tenant list. Meaningful only
   * inside `runInUserContext(platformOwnerId)`, relying on the additive
   * `organizations_platform_select` RLS policy (P15 migration) rather
   * than any org-scoped WHERE clause — there is no single tenant context
   * to scope by here. `_count` resolves `academyCount`/`memberCount` in
   * the SAME query (Prisma relation aggregation), never a second
   * per-row query — each counted relation is itself subject to its own
   * `_platform_select` policy, so this respects RLS exactly like a plain
   * `findMany` would.
   */
  async findManyAnyOrganization(
    tx: Prisma.TransactionClient,
    filter: { readonly search?: string; readonly skip: number; readonly take: number },
  ): Promise<{ items: OrganizationWithCounts[]; totalItems: number }> {
    const where: Prisma.OrganizationWhereInput = filter.search
      ? { name: { contains: filter.search, mode: 'insensitive' as const } }
      : {};

    const [items, totalItems] = await Promise.all([
      tx.organization.findMany({
        where,
        include: { _count: { select: { academies: true, memberships: true } } },
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.organization.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** Phase P15 — the Platform Owner's cross-tenant detail read. Same RLS/context rule as `findManyAnyOrganization`. */
  findByIdAnyOrganization(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<OrganizationWithOwnerAndCounts | null> {
    return tx.organization.findUnique({
      where: { id },
      include: {
        _count: { select: { academies: true, memberships: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    });
  }
}
