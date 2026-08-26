/**
 * TenantAddOnsRepository — see `TenantSubscriptionsRepository`'s doc
 * comment for the shared rule. `activate` is a P12 addition: reuses P4's
 * existing `tenant_add_ons_insert` RLS policy verbatim (no RLS change
 * needed here, unlike `tenant_subscriptions`) — `upsert` on the
 * `(organizationId, addOnId)` unique constraint makes re-purchasing an
 * already-active add-on a safe no-op rather than a duplicate-row error.
 */
import { Injectable } from '@nestjs/common';
import type { AddOn, Prisma, TenantAddOn } from '@prisma/client';

@Injectable()
export class TenantAddOnsRepository {
  findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<(TenantAddOn & { addOn: AddOn })[]> {
    return tx.tenantAddOn.findMany({
      where: { organizationId },
      include: { addOn: true },
      orderBy: { activatedAt: 'asc' },
    });
  }

  activate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnId: string,
  ): Promise<TenantAddOn> {
    return tx.tenantAddOn.upsert({
      where: { organizationId_addOnId: { organizationId, addOnId } },
      update: {},
      create: { organizationId, addOnId },
    });
  }
}
