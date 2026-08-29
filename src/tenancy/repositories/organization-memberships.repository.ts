/**
 * OrganizationMembershipsRepository.
 *
 * Every method takes a `Prisma.TransactionClient`, never the raw
 * `PrismaService`, by design — it's the caller's job to have already
 * opened one via `TenancyContextService.runInTenantContext`, so it is
 * structurally impossible to call this repository without an RLS tenant
 * context active. Forgetting to do so doesn't leak data (see
 * `TenancyContextService`'s doc comment: an unset session variable makes
 * every RLS-protected row invisible, fail-closed, not fail-open).
 */
import { Injectable } from '@nestjs/common';
import type { OrganizationMembership, Prisma, User } from '@prisma/client';

export type OrganizationMembershipWithUser = OrganizationMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

/** A reasonable cap on a single organization's/academy's member list nested inside a Platform Owner detail view — defensive, matching master plan §27 ("avoid unbounded list endpoints"), even though the frontend contract itself declares no limit. Real pagination for a Platform Owner "browse this org's full membership" surface is out of P15's defined scope. */
export const PLATFORM_DETAIL_MEMBER_CAP = 200;

@Injectable()
export class OrganizationMembershipsRepository {
  /**
   * Phase P19 — the owner-membership half of real Organization creation
   * (see `OrganizationsRepository.create`'s doc comment for the RLS
   * session-variable choreography this depends on). `permissions` is
   * caller-supplied, not defaulted here — `OrganizationsService.create`
   * passes the real owner permission set (see
   * `src/tenancy/constants/organization-permissions.constants.ts`),
   * closing the separate, previously-always-empty-permissions gap
   * (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-2) in the same stroke.
   */
  create(
    tx: Prisma.TransactionClient,
    data: {
      readonly organizationId: string;
      readonly userId: string;
      readonly role: string;
      readonly permissions: readonly string[];
      readonly isPrimary: boolean;
    },
  ): Promise<OrganizationMembership> {
    return tx.organizationMembership.create({
      data: {
        organizationId: data.organizationId,
        userId: data.userId,
        role: data.role,
        permissions: [...data.permissions],
        isPrimary: data.isPrimary,
      },
    });
  }

  /** Finds the caller's own membership row within the active tenant context — this IS the membership-verification query (see `OrganizationMembershipGuard`). */
  findForUserInOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    return tx.organizationMembership.findFirst({ where: { organizationId, userId } });
  }

  /**
   * All of one user's memberships, across whichever organizations RLS
   * currently permits. Used by the identity layer's `CurrentUser`
   * projection (`runInUserContext(sameUserId)`, the `_self_select`
   * policy) AND, additively since Phase P15, by
   * `PlatformUsersService.getUser` for an ARBITRARY other user's
   * memberships (`runInUserContext(platformOwnerId)`, the new
   * `organization_memberships_platform_select` policy — see the P15
   * migration's own doc comment) — the query itself needed no change,
   * only a new RLS policy the SAME query now also satisfies.
   */
  findAllForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<OrganizationMembership[]> {
    return tx.organizationMembership.findMany({ where: { userId } });
  }

  /** Phase P15 — one organization's full member list for `PlatformOrganizationDetail.members`. Meaningful only inside `runInUserContext(platformOwnerId)` (the `_platform_select` policy); capped, not paginated — see `PLATFORM_DETAIL_MEMBER_CAP`. */
  findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationMembershipWithUser[]> {
    return tx.organizationMembership.findMany({
      where: { organizationId },
      orderBy: { joinedAt: 'asc' },
      take: PLATFORM_DETAIL_MEMBER_CAP,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /** Phase P15 — `PlatformUserSummary.organizationCount`. */
  countForUser(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    return tx.organizationMembership.count({ where: { userId } });
  }

  /**
   * Phase P15 — the SAME count as `countForUser`, computed for a whole
   * PAGE of users in one query (`GROUP BY user_id`) rather than one query
   * per row — `PlatformUsersService.listUsers`'s N+1-avoidance (master
   * plan §27). Meaningful only inside `runInUserContext(platformOwnerId)`
   * (the `organization_memberships_platform_select` policy — this is a
   * genuinely cross-user aggregate, unlike `findAllForUser`'s
   * single-target-user reuse of the self-select policy).
   */
  async countManyForUsers(
    tx: Prisma.TransactionClient,
    userIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const grouped = await tx.organizationMembership.groupBy({
      by: ['userId'],
      where: { userId: { in: [...userIds] } },
      _count: { _all: true },
    });
    return new Map(grouped.map((row) => [row.userId, row._count._all]));
  }
}
