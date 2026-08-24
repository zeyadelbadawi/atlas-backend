/**
 * TenantUsageRepository — see `TenantSubscriptionsRepository`'s doc
 * comment for the shared rule. `upsert` is the recompute worker's only
 * write path — always a full overwrite of every metric (never an
 * increment), matching master plan §12's "idempotent full recompute,
 * never incremental" rule shared with the analogous Storage Quota job.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, TenantUsage } from '@prisma/client';

export interface TenantUsageCounts {
  readonly academies: number;
  readonly students: number;
  readonly instructors: number;
  readonly staff: number;
  readonly courses: number;
  readonly generalStorageGb: number;
  readonly videoStorageGb: number;
}

@Injectable()
export class TenantUsageRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantUsage | null> {
    return tx.tenantUsage.findUnique({ where: { organizationId } });
  }

  upsert(
    tx: Prisma.TransactionClient,
    organizationId: string,
    counts: TenantUsageCounts,
  ): Promise<TenantUsage> {
    return tx.tenantUsage.upsert({
      where: { organizationId },
      create: { organizationId, ...counts },
      update: { ...counts },
    });
  }
}
