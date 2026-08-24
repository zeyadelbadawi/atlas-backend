/**
 * TenantSubscriptionsRepository — `tenant_subscriptions` is organization-
 * scoped and RLS-protected; every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching `OrganizationsRepository`'s established rule.
 */
import { Injectable } from '@nestjs/common';
import type { Plan, Prisma, TenantSubscription } from '@prisma/client';

@Injectable()
export class TenantSubscriptionsRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<(TenantSubscription & { plan: Plan }) | null> {
    return tx.tenantSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
  }
}
