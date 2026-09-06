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
   * Phase 4.6 (scalability fix) — bounded replacement for
   * `UserOrganizationsService.getMembershipsForUser`'s former use of
   * `findAllVisible` above. `findAllVisible` itself is left untouched (the
   * same "additive, not replacing" precedent this file already follows for
   * `findAllIdsPlatformWide` → `findStaleUsageOrganizationIds`), in case a
   * genuine "every organization this session can see" read is ever needed
   * elsewhere.
   *
   * `findAllVisible`'s one caller already knows every organization id it
   * needs — they come from the user's own `organization_memberships` rows
   * (fetched moments earlier via `findAllForUser`, which is indexed on
   * `user_id`) — so there is no reason to ask the database to re-derive
   * "every organization visible to this session" from an unfiltered scan.
   * `WHERE id IN (...)` filters on the `organizations` primary key: a cheap
   * indexed lookup for a handful of ids regardless of total platform size,
   * and it composes with (never bypasses) whatever `organizations_select`
   * RLS policy is already in force for the session — an id outside both
   * `ids` and what RLS permits is excluded either way, so tenant isolation
   * and platform-owner behavior are unchanged.
   */
  findManyVisibleByIds(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
  ): Promise<Organization[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.organization.findMany({ where: { id: { in: [...ids] } } });
  }

  /**
   * Phase 2 — the subscription-sweep's own platform-wide enumeration:
   * every organization id on the platform, unpaginated (the sweep needs
   * to enqueue a recompute for ALL of them, not one page at a time).
   * Meaningful only inside `runInUserContext(<a real platform-owner id>)`,
   * relying on the same `organizations_platform_select` policy (P15)
   * `findManyAnyOrganization` below already uses — kept as its own narrow
   * method rather than reusing that one with an unbounded `take`, since
   * returning only `id` avoids fetching every organization's full row
   * (name, timestamps, owner) for a job that only ever needs the id.
   */
  findAllIdsPlatformWide(
    tx: Prisma.TransactionClient,
  ): Promise<Pick<Organization, 'id'>[]> {
    return tx.organization.findMany({ select: { id: true } });
  }

  /**
   * Phase 4.5.2 (scalability) — the bounded replacement for
   * `SubscriptionSweepService`'s use of `findAllIdsPlatformWide` above.
   * `findAllIdsPlatformWide` itself is left untouched (ATLAS_SCALABILITY_
   * ARCHITECTURE_PLAN.md's own Phase 4.5.2 file note: "a new... finder
   * alongside — not replacing" it) in case a genuine full-platform
   * enumeration is ever needed elsewhere; the sweep no longer calls it.
   *
   * Returns up to `limit` organization ids whose usage is either missing
   * entirely (`usage: null` — a brand-new organization whose reactive
   * write-path trigger hasn't landed yet, or one that predates this
   * mechanism) or older than `olderThan` — never an organization already
   * recomputed within the staleness window. This is what makes one sweep
   * tick's fan-out bounded by how much has actually gone stale, not by
   * total platform organization count: at steady state, only the
   * organizations a reactive trigger genuinely missed are ever
   * re-enqueued, exactly matching the "safety net for the reactive
   * triggers, not a replacement for them" role this sweep has always had
   * (see `SubscriptionSweepService`'s own doc comment).
   *
   * Cursor-paginated (`id > cursor`, ordered by `id` ascending) rather
   * than offset-based: `organizations.id` is the primary key, so this
   * scan is a cheap indexed range regardless of how deep the cursor is —
   * an `OFFSET N` pagination would itself become O(N) at high page
   * counts, defeating the entire point of bounding a single tick's cost.
   * `tenant_usage.organization_id` is that table's own primary key, so
   * the `usage` relation check is a cheap point lookup per candidate row,
   * not a second table scan.
   *
   * Meaningful only inside `runInUserContext(<a real platform-owner id>)`,
   * exactly like `findAllIdsPlatformWide` above — same
   * `organizations_platform_select` RLS policy, same reasoning.
   */
  findStaleUsageOrganizationIds(
    tx: Prisma.TransactionClient,
    olderThan: Date,
    cursor: string | undefined,
    limit: number,
  ): Promise<Pick<Organization, 'id'>[]> {
    return tx.organization.findMany({
      where: {
        id: cursor ? { gt: cursor } : undefined,
        OR: [{ usage: null }, { usage: { updatedAt: { lt: olderThan } } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
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
