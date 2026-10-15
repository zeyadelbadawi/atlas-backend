/** `AcademyPayout`/`AcademyPayoutItem` response contracts (Phase P13, master plan §5.8). */
import type {
  AcademyPayout as PrismaAcademyPayout,
  AcademyPayoutItem as PrismaAcademyPayoutItem,
} from '@prisma/client';
import type { DashboardManualSalesResponse } from '../../dashboard/dto/dashboard-overview.contract';

export interface AcademyPayoutResponse {
  readonly id: string;
  readonly academyId: string;
  readonly status: PrismaAcademyPayout['status'];
  readonly money: { readonly amountMinorUnits: number; readonly currency: string };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly paidAt?: string;
  readonly providerReference?: string;
  readonly itemCount?: number;
  readonly createdAt: string;
}

export function toAcademyPayoutResponse(
  payout: PrismaAcademyPayout & { items?: PrismaAcademyPayoutItem[] },
): AcademyPayoutResponse {
  return {
    id: payout.id,
    academyId: payout.academyId,
    status: payout.status,
    money: {
      amountMinorUnits: Number(payout.amountMinorUnits),
      currency: payout.currency,
    },
    periodStart: payout.periodStart.toISOString(),
    periodEnd: payout.periodEnd.toISOString(),
    paidAt: payout.paidAt?.toISOString(),
    providerReference: payout.providerReference ?? undefined,
    itemCount: payout.items?.length,
    createdAt: payout.createdAt.toISOString(),
  };
}

/** The unsettled-balance summary an Academy/Platform Owner reads before triggering a payout — computed live from unsettled `revenue_ledger_entries`, never persisted (matches master plan §14's "operational data is never queried live for DASHBOARD rendering" scope — this is a payout-computation read, not an analytics snapshot, so that rule does not apply here). */
export interface AcademyRevenueSummaryResponse {
  readonly academyId: string;
  /**
   * The Atlas Payments ledger balance not yet paid out. Only Atlas Payments
   * sales write ledger rows, and that mode is not launched (B0-COM-03), so
   * for an academy selling with manual payments this is empty — it is NOT
   * the academy's sales.
   */
  readonly unsettled: readonly {
    readonly currency: string;
    readonly amountMinorUnits: number;
  }[];
  /**
   * D5-5 (B0-COM-02) — added field. The dashboard card's manual-sales figure
   * for THIS academy, from the same query and the same rule: succeeded
   * academy-manual payments whose order is still `paid`, gross, per
   * 7/30/90 days by the order's `paidAt`. Never ledger revenue and never
   * net of fees. Same owner-only authorization as the rest of this read.
   */
  readonly manualSales: DashboardManualSalesResponse;
}
