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
import type { OrganizationMembership, Prisma } from '@prisma/client';

@Injectable()
export class OrganizationMembershipsRepository {
  /** Finds the caller's own membership row within the active tenant context — this IS the membership-verification query (see `OrganizationMembershipGuard`). */
  findForUserInOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ): Promise<OrganizationMembership | null> {
    return tx.organizationMembership.findFirst({ where: { organizationId, userId } });
  }

  /** All of one user's memberships, across whichever organizations RLS currently permits. Used only by the identity layer's `CurrentUser` projection — see its own doc comment for why that call site is exempt from the single-tenant-context model. */
  findAllForUser(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<OrganizationMembership[]> {
    return tx.organizationMembership.findMany({ where: { userId } });
  }
}
