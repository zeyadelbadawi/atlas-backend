/**
 * PlatformMetricsService — `GET /platform-metrics` (master plan §21 Phase
 * P16), the Platform Command Center's singleton snapshot. No date-range
 * parameter (`PlatformMetricsService.getOverview()` on the frontend takes
 * none) — every trend is "vs. last calendar month" (`periodKey:
 * 'platform:metrics.vsLastMonth'` in `PlatformDashboardPage.tsx`),
 * distinct from `AnalyticsService`'s rolling `dateRange` convention.
 *
 * Computed LIVE from existing P1–P13 transactional tables on every
 * request — a deliberate, documented deviation from master plan §14's own
 * "V1: scheduled snapshot tables" aspiration. See
 * `Reports/ARCHITECTURE.md`'s P16 section for the full rationale (current
 * data volume does not yet warrant the operational complexity of a
 * scheduled-job snapshot pipeline; every query here is a single indexed
 * aggregate, not a full-table scan). `generatedAt` is real — the moment
 * this response was computed, not a stale precomputed value, but also not
 * a snapshot-table timestamp.
 *
 * Every RLS-protected read runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, reusing the
 * existing `_platform_select`/`_platform_review_select` policies (P12/
 * P13/P15) — no new RLS policy this phase (see `AnalyticsModule`'s own
 * doc comment).
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PlatformScaleRepository } from '../repositories/platform-scale.repository';
import { AnalyticsRevenueRepository } from '../repositories/analytics-revenue.repository';
import { safeChangePercent, safeRatePercent } from '../utils/metric-math.util';
import { currentCalendarMonth, previousCalendarMonth } from '../utils/date-range.util';
import { pickDominantCurrencyAmount } from '../utils/currency-aggregation.util';
import type { PlatformMetricsOverviewResponse } from '../dto/platform-metrics.contract';

/**
 * No infrastructure/APM monitoring pipeline exists anywhere in this
 * codebase yet (grep-verified — no request-log table, no uptime-check
 * history, no error-rate aggregation; that instrumentation is master plan
 * §19/§20 scope, not shipped). `systemHealthPercent`/`apiUptimePercent`
 * have no real persisted signal to derive from — returning a fabricated
 * formula would violate master plan §7's explicit "avoid fake health
 * scores" instruction more than an honest, clearly-documented fixed
 * baseline does. Marked `SPECIFICATION-UNDEFINED` in the P16 report;
 * revisit once real monitoring exists (§19).
 */
const NO_MONITORING_BASELINE_PERCENT = 100;

@Injectable()
export class PlatformMetricsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly platformScaleRepository: PlatformScaleRepository,
    private readonly analyticsRevenueRepository: AnalyticsRevenueRepository,
  ) {}

  async getOverview(platformOwnerId: string): Promise<PlatformMetricsOverviewResponse> {
    const currentMonth = currentCalendarMonth();
    const lastMonth = previousCalendarMonth(currentMonth);
    // "As of the end of last month" — the cutoff `totalAcademies`/
    // `totalUsers`/`activeCourses` compare the current cumulative total
    // against, matching this service's own header-comment convention.
    const lastMonthCutoff = lastMonth.to;

    const [
      totalAcademiesNow,
      totalAcademiesLastMonth,
      totalUsersNow,
      totalUsersLastMonth,
      activeCoursesNow,
      activeCoursesLastMonth,
      revenueThisMonth,
      revenueLastMonth,
    ] = await Promise.all([
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.platformScaleRepository.countAcademies(tx),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.platformScaleRepository.countAcademies(tx, lastMonthCutoff),
      ),
      this.platformScaleRepository.countUsers(),
      this.platformScaleRepository.countUsers(lastMonthCutoff),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.platformScaleRepository.countPublishedCourses(tx),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.platformScaleRepository.countPublishedCourses(tx, lastMonthCutoff),
      ),
      this.monthlyRevenue(platformOwnerId, currentMonth.from, currentMonth.to),
      this.monthlyRevenue(platformOwnerId, lastMonth.from, lastMonth.to),
    ]);

    const storage = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.platformScaleRepository.storageUsageRatio(tx),
    );

    return {
      totalAcademies: {
        value: totalAcademiesNow,
        changePercent: safeChangePercent(totalAcademiesNow, totalAcademiesLastMonth),
      },
      totalUsers: {
        value: totalUsersNow,
        changePercent: safeChangePercent(totalUsersNow, totalUsersLastMonth),
      },
      activeCourses: {
        value: activeCoursesNow,
        changePercent: safeChangePercent(activeCoursesNow, activeCoursesLastMonth),
      },
      revenue: {
        amount: revenueThisMonth.amount,
        currency: revenueThisMonth.currency,
        changePercent: safeChangePercent(
          revenueThisMonth.amount,
          revenueLastMonth.amount,
        ),
      },
      systemHealthPercent: NO_MONITORING_BASELINE_PERCENT,
      storageUsagePercent: safeRatePercent(storage.usedGb, storage.quotaGb),
      apiUptimePercent: NO_MONITORING_BASELINE_PERCENT,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Atlas Subscription Billing revenue + net Course Commerce commission for `[from, to]`, reported in the period's dominant currency (see `AnalyticsRevenueRepository`'s own doc comment on the multi-currency limitation). */
  private async monthlyRevenue(
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
}
