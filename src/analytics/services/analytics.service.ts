/**
 * AnalyticsService — `GET /analytics/overview`, `GET
 * /analytics/time-series/:metric`, `GET /analytics/breakdown/:dimension`
 * (master plan §21 Phase P16), the date-ranged Analytics tab. Every read
 * is computed LIVE (see `PlatformMetricsService`'s own doc comment for the
 * full "why not a scheduled snapshot pipeline yet" rationale — identical
 * reasoning applies here).
 *
 * `totalUsers` is a STOCK metric (cumulative-as-of, compared start- vs.
 * end-of-range); `activeUsers`/`revenue` are FLOW metrics (summed within
 * the range, compared against the immediately preceding period of equal
 * length via `previousPeriod`) — a real, documented interpretation choice
 * where the frontend contract itself doesn't define the exact formula
 * (`AnalyticsMetricTrend`'s own doc comment only says "current value plus
 * change over the selected date range"). See `Reports/ARCHITECTURE.md`'s
 * P16 section for the full write-up.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PlatformScaleRepository } from '../repositories/platform-scale.repository';
import { AnalyticsRevenueRepository } from '../repositories/analytics-revenue.repository';
import {
  safeChangePercent,
  safeRatePercent,
  minorUnitsToDecimal,
} from '../utils/metric-math.util';
import {
  resolveDateRange,
  previousPeriod,
  enumerateDays,
} from '../utils/date-range.util';
import type { ResolvedDateRange } from '../utils/date-range.util';
import { fillFlowSeries, fillCumulativeSeries } from '../utils/series-fill.util';
import {
  pickDominantCurrencyAmount,
  sumByCurrency,
} from '../utils/currency-aggregation.util';
import {
  SUPPORTED_TIME_SERIES_METRICS,
  SUPPORTED_BREAKDOWN_DIMENSIONS,
} from '../dto/analytics.contract';
import type {
  AnalyticsOverviewResponse,
  AnalyticsTimeSeriesResponse,
  AnalyticsBreakdownResponse,
} from '../dto/analytics.contract';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly platformScaleRepository: PlatformScaleRepository,
    private readonly analyticsRevenueRepository: AnalyticsRevenueRepository,
  ) {}

  async getOverview(
    platformOwnerId: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<AnalyticsOverviewResponse> {
    const range = resolveDateRange(from, to);
    const previous = previousPeriod(range);

    const [totalUsersNow, totalUsersAtStart, totalUsersAtPrevStart] = await Promise.all([
      this.platformScaleRepository.countUsers(range.to),
      this.platformScaleRepository.countUsers(new Date(range.from.getTime() - 1)),
      this.platformScaleRepository.countUsers(new Date(previous.from.getTime() - 1)),
    ]);

    const [activeUsersNow, activeUsersPrevious] = await Promise.all([
      this.platformScaleRepository.countActiveUsers(range.from, range.to),
      this.platformScaleRepository.countActiveUsers(previous.from, previous.to),
    ]);

    const [revenueNow, revenuePrevious] = await Promise.all([
      this.periodRevenue(platformOwnerId, range.from, range.to),
      this.periodRevenue(platformOwnerId, previous.from, previous.to),
    ]);

    const engagementRatePercent = safeRatePercent(activeUsersNow, totalUsersNow);
    const engagementRatePrevious = safeRatePercent(
      activeUsersPrevious,
      totalUsersAtPrevStart,
    );

    return {
      totalUsers: {
        value: totalUsersNow,
        changePercent: safeChangePercent(totalUsersNow, totalUsersAtStart),
      },
      activeUsers: {
        value: activeUsersNow,
        changePercent: safeChangePercent(activeUsersNow, activeUsersPrevious),
      },
      engagementRatePercent,
      engagementRateChangePercent: safeChangePercent(
        engagementRatePercent,
        engagementRatePrevious,
      ),
      revenue: {
        value: revenueNow.amount,
        changePercent: safeChangePercent(revenueNow.amount, revenuePrevious.amount),
      },
      revenueCurrency: revenueNow.currency,
      generatedAt: new Date().toISOString(),
    };
  }

  async getTimeSeries(
    platformOwnerId: string,
    metric: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<AnalyticsTimeSeriesResponse> {
    if (!SUPPORTED_TIME_SERIES_METRICS.includes(metric as never)) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const range = resolveDateRange(from, to);
    const days = enumerateDays(range);

    if (metric === 'users') {
      const values = await this.cumulativeUsersSeries(days, range);
      return this.toSeries('users', days, values);
    }
    if (metric === 'engagement') {
      const values = await this.engagementSeries(days, range);
      return this.toSeries('engagement', days, values);
    }
    // metric === 'revenue'
    const values = await this.revenueSeries(platformOwnerId, days, range);
    return this.toSeries('revenue', days, values);
  }

  async getBreakdown(
    platformOwnerId: string,
    dimension: string,
    from: string | undefined,
    to: string | undefined,
  ): Promise<AnalyticsBreakdownResponse> {
    if (!SUPPORTED_BREAKDOWN_DIMENSIONS.includes(dimension as never)) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const range = resolveDateRange(from, to);

    const rows = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.analyticsRevenueRepository.subscriptionRevenueByCurrentPlan(
          tx,
          range.from,
          range.to,
        ),
    );
    if (rows.length === 0) return { dimension: 'plan', items: [] };

    // Same "one dominant currency" rule as the overview KPI — see
    // `pickDominantCurrencyAmount`'s own doc comment.
    const totalsByCurrency = sumByCurrency(
      rows.map((r) => ({ currency: r.currency, amountMinorUnits: r.amountMinorUnits })),
    );
    const [dominantCurrency] = [...totalsByCurrency.entries()].sort((a, b) =>
      b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
    )[0];

    const items = rows
      .filter((r) => r.currency === dominantCurrency)
      .map((r) => ({ label: r.planName, value: minorUnitsToDecimal(r.amountMinorUnits) }))
      .sort((a, b) => b.value - a.value);

    return { dimension: 'plan', items };
  }

  // --- internals --------------------------------------------------------

  private async periodRevenue(
    platformOwnerId: string,
    from: Date,
    to: Date,
  ): Promise<{ amount: number; currency: string }> {
    const [subscription, commission] = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => [
        await this.analyticsRevenueRepository.subscriptionRevenue(tx, from, to),
        await this.analyticsRevenueRepository.commissionRevenue(tx, from, to),
      ],
    );
    return pickDominantCurrencyAmount([...subscription, ...commission]);
  }

  private async cumulativeUsersSeries(
    days: readonly string[],
    range: ResolvedDateRange,
  ): Promise<number[]> {
    const [rows, baseline] = await Promise.all([
      this.platformScaleRepository.usersCreatedByDay(range.to),
      this.platformScaleRepository.countUsers(new Date(range.from.getTime() - 1)),
    ]);
    const byDay = new Map(rows.map((r) => [r.day, r.count]));
    // Only the days within the requested range carry a "new count" —
    // `usersCreatedByDay` returns every day up to `to` (needed to compute
    // an accurate baseline is handled separately above via a direct
    // `countUsers` call, so entries before `range.from` are simply
    // ignored here).
    const newCountsInRange = new Map(days.map((day) => [day, byDay.get(day) ?? 0]));
    return fillCumulativeSeries(days, newCountsInRange, baseline);
  }

  private async engagementSeries(
    days: readonly string[],
    range: ResolvedDateRange,
  ): Promise<number[]> {
    const [activeRows, cumulativeTotals] = await Promise.all([
      this.platformScaleRepository.activeUsersByDay(range.from, range.to),
      this.cumulativeUsersSeries(days, range),
    ]);
    const activeByDay = new Map(activeRows.map((r) => [r.day, r.count]));
    const activeSeries = fillFlowSeries(days, activeByDay);
    return days.map((_, i) => safeRatePercent(activeSeries[i], cumulativeTotals[i]));
  }

  private async revenueSeries(
    platformOwnerId: string,
    days: readonly string[],
    range: ResolvedDateRange,
  ): Promise<number[]> {
    const [subscriptionDaily, commissionDaily] =
      await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => [
        await this.analyticsRevenueRepository.subscriptionRevenueByDay(
          tx,
          range.from,
          range.to,
        ),
        await this.analyticsRevenueRepository.commissionRevenueByDay(
          tx,
          range.from,
          range.to,
        ),
      ]);
    const combined = [...subscriptionDaily, ...commissionDaily];
    const totals = sumByCurrency(combined);
    if (totals.size === 0) return days.map(() => 0);
    const [dominantCurrency] = [...totals.entries()].sort((a, b) =>
      b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
    )[0];

    const byDay = new Map<string, bigint>();
    for (const row of combined) {
      if (row.currency !== dominantCurrency) continue;
      byDay.set(row.day, (byDay.get(row.day) ?? 0n) + row.amountMinorUnits);
    }
    return days.map((day) => minorUnitsToDecimal(byDay.get(day) ?? 0n));
  }

  private toSeries(
    metric: string,
    days: readonly string[],
    values: readonly number[],
  ): AnalyticsTimeSeriesResponse {
    return {
      metric,
      points: days.map((date, i) => ({ date, value: values[i] })),
    };
  }
}
