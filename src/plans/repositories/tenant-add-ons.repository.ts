/** TenantAddOnsRepository — see `TenantSubscriptionsRepository`'s doc comment for the shared rule. */
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
}
