/**
 * `DashboardOverview` response contract (Phase 8) — the one aggregation a
 * tenant's dashboard reads, assembled server-side so the frontend never
 * fans out to five endpoints and never filters another scope's data out
 * client-side.
 *
 * REVENUE — the single most important honesty boundary in this file.
 * `revenue.totals` is a real `SUM(amount_minor_units)` over
 * `revenue_ledger_entries`, grouped by currency, using that table's own
 * documented signed-amount convention (a `sale` is positive, a
 * `platform_fee` negative, so the sum directly yields what the Academy is
 * actually owed — schema.prisma's own P13 header comment). It is NEVER
 * estimated, projected, or derived from anything but that ledger.
 *
 * But that ledger is only populated for Organizations in Atlas Payments
 * mode: "Organization-Owned Gateway transactions insert no ledger row at
 * all" (same header comment — the deliberate enforcement of "Atlas must
 * not create an Atlas commission liability from a transaction it was
 * never a party to"). For an Organization in `organization_gateway` mode,
 * Atlas therefore genuinely does not know its revenue — the money moved
 * through the customer's own gateway and Atlas was never a party to it.
 * Reporting `0` there would be a fabricated figure dressed as a real one,
 * so `tracked: false` is returned instead, alongside the real
 * `paymentCollectionMode`, and the frontend renders an honest "not
 * tracked by Atlas" state rather than a misleading zero. `tracked` is
 * true ONLY in `atlas_payments` mode, where the ledger is genuinely
 * authoritative.
 *
 * `usage` is `null`, never a zero-filled placeholder, when the
 * organization has no subscription or the `tenant-usage-recompute` worker
 * has never run for it — reusing `TenantSubscriptionService.getUsage`'s
 * own already-established honest-empty-state semantics verbatim rather
 * than inventing a second interpretation of the same absence.
 */
import type { PaymentCollectionMode } from '@prisma/client';
import type { TenantUsageResponse } from '../../plans/dto/tenant-usage.contract';

export interface DashboardScopeResponse {
  readonly type: 'organization' | 'academy';
  readonly organizationId: string;
  /** Present only for `type: 'academy'` — the one Academy this dashboard is narrowed to. */
  readonly academyId?: string;
  readonly academyName?: string;
}

export interface DashboardCountsResponse {
  /**
   * Organization scope only — an Academy-scoped dashboard reports `1`
   * (itself), never the Organization's total, which a Manager has no
   * business seeing.
   */
  readonly academies: number;
  readonly courses: number;
  readonly publishedCourses: number;
  readonly students: number;
  readonly instructors: number;
}

export interface DashboardRevenueTotalResponse {
  readonly currency: string;
  readonly amountMinorUnits: number;
}

export interface DashboardRevenueResponse {
  /** See this file's header comment — `false` means Atlas genuinely has no revenue data for this Organization, never "zero revenue". */
  readonly tracked: boolean;
  readonly paymentCollectionMode: PaymentCollectionMode;
  /** Empty when `tracked` is false, or when the ledger genuinely holds no entries yet. */
  readonly totals: readonly DashboardRevenueTotalResponse[];
}

export interface DashboardActivityItemResponse {
  readonly id: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetLabel?: string;
  readonly actorName: string;
  /** The actor's real role at the time of the action — `null` for entries written before Phase 8 added the column. */
  readonly actorRole?: string;
  readonly academyId?: string;
  readonly occurredAt: string;
}

export interface DashboardOverviewResponse {
  readonly scope: DashboardScopeResponse;
  readonly counts: DashboardCountsResponse;
  readonly revenue: DashboardRevenueResponse;
  readonly usage: TenantUsageResponse | null;
  readonly recentActivity: readonly DashboardActivityItemResponse[];
}
