/**
 * OrganizationCommissionSettingsRepository — `organization_commission_settings`
 * (master plan §4.2/§5.8). RLS enforces the asymmetric read/write rule
 * itself (an Organization can `SELECT` its own row; only a Platform Owner
 * can `INSERT`/`UPDATE` any row) — this repository does not re-implement
 * that check, it only shapes the queries. `read` runs under either a
 * tenant or a platform-owner context (both have a matching SELECT policy);
 * `upsert` must run under `TenancyContextService.runInUserContext` for a
 * verified Platform Owner — see `CommissionService`.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, OrganizationCommissionSettings } from '@prisma/client';

@Injectable()
export class OrganizationCommissionSettingsRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationCommissionSettings | null> {
    return tx.organizationCommissionSettings.findUnique({ where: { organizationId } });
  }

  /** Platform-Owner-only write path (RLS-enforced, not merely convention) — see this class's own doc comment. */
  upsert(
    tx: Prisma.TransactionClient,
    organizationId: string,
    data: {
      readonly commissionMode: OrganizationCommissionSettings['commissionMode'];
      readonly customPercentageBasisPoints: number | null;
      readonly updatedBy: string;
    },
  ): Promise<OrganizationCommissionSettings> {
    return tx.organizationCommissionSettings.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
  }
}
