/**
 * AcademyPayoutsService — `academies/:id/payouts` (academy-scoped read,
 * master plan §10: "`/academy-payouts` (Academy-scoped read)"). Reuses
 * `AcademyScopeGuard` verbatim for authorization — an Academy's staff may
 * see their own payout history and unsettled balance, but never create or
 * edit a payout row (Platform-Owner-only write, `PlatformAcademyPayoutsService`).
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AcademyContext } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyPayoutsRepository } from '../repositories/academy-payouts.repository';
import { RevenueLedgerEntriesRepository } from '../repositories/revenue-ledger-entries.repository';
import {
  toAcademyPayoutResponse,
  type AcademyPayoutResponse,
} from '../dto/academy-payout.contract';
import type { AcademyRevenueSummaryResponse } from '../dto/academy-payout.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

@Injectable()
export class AcademyPayoutsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyPayoutsRepository: AcademyPayoutsRepository,
    private readonly revenueLedgerEntriesRepository: RevenueLedgerEntriesRepository,
  ) {}

  async listForAcademy(
    context: AcademyContext,
    academyId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyPayoutResponse>> {
    const organizationId = assertCanViewAcademyFinance(context);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.academyPayoutsRepository.findManyForAcademy(tx, academyId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAcademyPayoutResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** The unsettled ledger balance an Academy is currently owed, grouped by currency — never persisted, always computed fresh (matches this file's own contract doc comment). */
  async getRevenueSummary(
    context: AcademyContext,
    academyId: string,
  ): Promise<AcademyRevenueSummaryResponse> {
    const organizationId = assertCanViewAcademyFinance(context);
    const entries = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.revenueLedgerEntriesRepository.findUnsettledForAcademy(
          tx,
          academyId,
          new Date(),
        ),
    );

    const totalsByCurrency = new Map<string, bigint>();
    for (const entry of entries) {
      const running = totalsByCurrency.get(entry.currency) ?? 0n;
      totalsByCurrency.set(entry.currency, running + entry.amountMinorUnits);
    }

    return {
      academyId,
      unsettled: Array.from(totalsByCurrency.entries()).map(
        ([currency, amountMinorUnits]) => ({
          currency,
          amountMinorUnits: Number(amountMinorUnits),
        }),
      ),
    };
  }
}

/**
 * Academy revenue and payouts are money, and money is Organization-Owner
 * territory in the existing permission model: `tenant.billing.view`,
 * `tenant.payment.*` and the rest are in `ORGANIZATION_OWNER_PERMISSIONS`
 * only, and a Manager "deliberately never gets" them. Remediation of a
 * verified gap: this used to rely on `AcademyScopeGuard` alone, which
 * admits ANY organization member (and any active academy member) — so an
 * instructor, or the manager of a sibling academy, could read another
 * academy's revenue.
 *
 * RLS independently agrees at the organization boundary (payout and
 * ledger policies are organization-scoped), which is exactly the set an
 * Organization Owner is entitled to — so guard and RLS describe the same
 * scope. Returns the organization id the reads must run in.
 */
export function assertCanViewAcademyFinance(context: AcademyContext): string {
  if (context.organizationRole !== 'owner') {
    throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
  }
  return context.organizationId;
}
