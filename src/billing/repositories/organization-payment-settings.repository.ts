/**
 * OrganizationPaymentSettingsRepository — `organization_payment_settings`
 * (master plan §5.8). Tenant-scoped, RLS-protected — every method must run
 * inside a `TenancyContextService.runInTenantContext` transaction, matching
 * every other billing repository's own convention.
 *
 * Reads never insert a row: an Organization that has never touched this
 * setting has no row at all, and `findByOrganizationId` correctly returns
 * `null` for it — `OrganizationPaymentSettingsService` is the one place
 * that maps "no row" to the real `unconfigured` default (§4.1), so a
 * read never has the side effect of creating a row.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, OrganizationPaymentSettings } from '@prisma/client';

@Injectable()
export class OrganizationPaymentSettingsRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationPaymentSettings | null> {
    return tx.organizationPaymentSettings.findUnique({ where: { organizationId } });
  }

  /** The only write path — upserts so the first-ever mode selection and every subsequent change use the same call, never a find-then-create/update race. */
  upsertMode(
    tx: Prisma.TransactionClient,
    organizationId: string,
    paymentCollectionMode: OrganizationPaymentSettings['paymentCollectionMode'],
  ): Promise<OrganizationPaymentSettings> {
    return tx.organizationPaymentSettings.upsert({
      where: { organizationId },
      create: { organizationId, paymentCollectionMode },
      update: { paymentCollectionMode },
    });
  }
}
