/**
 * AnalyticsRevenueRepository — Atlas's own realized revenue, from the two
 * real money flows that exist in this codebase (master plan §21 Phase
 * P12/P13), never a third, invented one:
 *
 * 1. **Atlas Subscription Billing** (P12) — an Organization paying Atlas
 *    directly. A `succeeded` `payments` row with `organization_id` set IS
 *    Atlas revenue in full (Atlas is the seller).
 * 2. **Course Commerce commission** (P13) — Atlas is never the seller (the
 *    Academy is), so Atlas's own revenue from this flow is its commission
 *    only, never the full sale price. `revenue_ledger_entries`' signed
 *    convention (that table's own doc comment in `schema.prisma`) makes
 *    this a pure `SUM`, no separate refund-handling logic needed: a
 *    `platform_fee` row is the commission taken (negative, from the
 *    Academy's perspective), a `commission_reversal` row exactly reverses
 *    a prior `platform_fee` when its sale is refunded (positive) — so
 *    `-(SUM(platform_fee) + SUM(commission_reversal))` is the exact net
 *    commission Atlas actually keeps for the period, refunds already
 *    netted out, no separate "was this refunded" check required.
 *
 * Every query is grouped by `currency` (master plan §8: "do not sum
 * different currencies into one meaningless number") — the service layer
 * picks the single dominant currency to report on the closed-shape
 * `AnalyticsOverview`/`PlatformMetricsOverview` contracts (both carry
 * exactly one `currency` field), documented as this phase's explicit,
 * narrow multi-currency limitation (no conversion model exists anywhere
 * in this codebase to do otherwise).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface CurrencyAmount {
  readonly currency: string;
  readonly amountMinorUnits: bigint;
}

export interface DailyCurrencyAmount extends CurrencyAmount {
  readonly day: string;
}

@Injectable()
export class AnalyticsRevenueRepository {
  /** Successful, Organization-scoped (Atlas Subscription Billing) payment volume, grouped by currency. */
  async subscriptionRevenue(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
  ): Promise<CurrencyAmount[]> {
    const rows = await tx.payment.groupBy({
      by: ['currency'],
      where: {
        organizationId: { not: null },
        status: 'succeeded',
        createdAt: { gte: from, lte: to },
      },
      _sum: { amountMinorUnits: true },
    });
    return rows.map((r) => ({
      currency: r.currency,
      amountMinorUnits: r._sum.amountMinorUnits ?? 0n,
    }));
  }

  /** Same as `subscriptionRevenue`, bucketed by UTC day — for the `revenue` time-series metric's subscription-billing component. */
  async subscriptionRevenueByDay(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
  ): Promise<DailyCurrencyAmount[]> {
    const rows = await tx.$queryRaw<{ day: Date; currency: string; total: bigint }[]>`
      SELECT date_trunc('day', "created_at") AS day, "currency", SUM("amount_minor_units") AS total
      FROM "payments"
      WHERE "organization_id" IS NOT NULL AND "status" = 'succeeded'
        AND "created_at" >= ${from} AND "created_at" <= ${to}
      GROUP BY 1, 2
      ORDER BY 1
    `;
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      currency: r.currency,
      amountMinorUnits: r.total,
    }));
  }

  /** Atlas's net Course Commerce commission for the period (refunds already netted via `commission_reversal` — see this class's own doc comment), grouped by currency. */
  async commissionRevenue(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
  ): Promise<CurrencyAmount[]> {
    const rows = await tx.revenueLedgerEntry.groupBy({
      by: ['currency'],
      where: {
        entryType: { in: ['platform_fee', 'commission_reversal'] },
        occurredAt: { gte: from, lte: to },
      },
      _sum: { amountMinorUnits: true },
    });
    // `platform_fee` is negative, `commission_reversal` is positive
    // (partially offsetting it) — negating the combined signed sum yields
    // the net positive commission Atlas actually keeps, matching this
    // class's own header comment formula exactly.
    return rows.map((r) => ({
      currency: r.currency,
      amountMinorUnits: -(r._sum.amountMinorUnits ?? 0n),
    }));
  }

  /** Same as `commissionRevenue`, bucketed by UTC day. */
  async commissionRevenueByDay(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
  ): Promise<DailyCurrencyAmount[]> {
    const rows = await tx.$queryRaw<{ day: Date; currency: string; total: bigint }[]>`
      SELECT date_trunc('day', "occurred_at") AS day, "currency", SUM("amount_minor_units") AS total
      FROM "revenue_ledger_entries"
      WHERE "entry_type" IN ('platform_fee', 'commission_reversal')
        AND "occurred_at" >= ${from} AND "occurred_at" <= ${to}
      GROUP BY 1, 2
      ORDER BY 1
    `;
    // Each day mixes `platform_fee` (negative) and `commission_reversal`
    // (positive) rows already summed together by the `GROUP BY` above —
    // negate once per day, same formula as the singleton method.
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      currency: r.currency,
      amountMinorUnits: -r.total,
    }));
  }

  /**
   * Successful Atlas Subscription Billing revenue for the period, grouped
   * by the paying Organization's CURRENT plan (`tenant_subscriptions.
   * plan_id`) — not the plan actually in effect at each historical
   * payment's moment (that would require joining through `checkouts.
   * target_key`, a second RLS-protected table this phase has no other
   * need for; documented, narrow limitation — plan changes are
   * infrequent enough that this is a reasonable approximation for a
   * breakdown chart, matches master plan §7's "avoid unnecessary joins"
   * guidance). Two batched queries, never one per Organization.
   */
  async subscriptionRevenueByCurrentPlan(
    tx: Prisma.TransactionClient,
    from: Date,
    to: Date,
  ): Promise<{ planName: string; currency: string; amountMinorUnits: bigint }[]> {
    const perOrg = await tx.payment.groupBy({
      by: ['organizationId', 'currency'],
      where: {
        organizationId: { not: null },
        status: 'succeeded',
        createdAt: { gte: from, lte: to },
      },
      _sum: { amountMinorUnits: true },
    });
    if (perOrg.length === 0) return [];

    const organizationIds = [...new Set(perOrg.map((r) => r.organizationId as string))];
    const subscriptions = await tx.tenantSubscription.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { organizationId: true, plan: { select: { name: true } } },
    });
    const planNameByOrgId = new Map(
      subscriptions.map((s) => [s.organizationId, s.plan.name]),
    );

    const totals = new Map<string, bigint>();
    for (const row of perOrg) {
      const planName = planNameByOrgId.get(row.organizationId as string) ?? 'Unassigned';
      const key = `${planName}::${row.currency}`;
      totals.set(key, (totals.get(key) ?? 0n) + (row._sum.amountMinorUnits ?? 0n));
    }

    return [...totals.entries()].map(([key, amountMinorUnits]) => {
      const [planName, currency] = key.split('::');
      return { planName, currency, amountMinorUnits };
    });
  }
}
