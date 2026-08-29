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

  findBySlug(tx: Prisma.TransactionClient, slug: string): Promise<Organization | null> {
    return tx.organization.findUnique({ where: { slug } });
  }

  /**
   * Phase P19 — real Organization creation, previously missing entirely
   * (see `Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-1). `id` is caller-
   * supplied (a pre-generated UUID), never DB-generated here — the caller
   * must know the new organization's id BEFORE this insert so it can open
   * `runInTenantAndUserContext(id, ownerUserId, ...)` around both this
   * call and the owner-membership insert that follows it in the same
   * transaction: `organizations_insert`'s RLS policy only permits
   * `owner_user_id = app.current_user_id` (any org id), but
   * `organization_memberships_insert`'s policy additionally requires the
   * target organization to already be SELECT-visible under
   * `app.current_organization_id` — which only holds if that session
   * variable is set to this exact new id from the start (see
   * `prisma/migrations/20260823184500_p2_narrow_insert_rls_policies/
   * migration.sql`'s own header comment, which predicted precisely this
   * bootstrap shape for "a future org-creation flow").
   */
  create(
    tx: Prisma.TransactionClient,
    data: {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly ownerUserId: string;
    },
  ): Promise<Organization> {
    return tx.organization.create({
      data: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        ownerUserId: data.ownerUserId,
      },
    });
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
