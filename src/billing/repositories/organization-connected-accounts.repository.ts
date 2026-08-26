/**
 * OrganizationConnectedAccountsRepository — `organization_connected_accounts`
 * (master plan §5.8). Tenant-scoped, RLS-protected. Schema/service
 * foundation only in this phase — no real Connect-style processor is
 * integrated and no onboarding-trigger endpoint exists yet (§4.1/§5.8 scope
 * boundary), so there is no write method at all here today.
 *
 * Reads never insert a row (same "no side effect on a read" rule
 * `OrganizationPaymentSettingsRepository` documents) —
 * `OrganizationConnectedAccountService` maps "no row" to the real
 * `not_started`/not-payouts-enabled default.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, OrganizationConnectedAccount } from '@prisma/client';

@Injectable()
export class OrganizationConnectedAccountsRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationConnectedAccount | null> {
    return tx.organizationConnectedAccount.findUnique({ where: { organizationId } });
  }
}
