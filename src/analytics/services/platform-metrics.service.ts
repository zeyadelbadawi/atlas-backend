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
import type { PlatformVideoMetricsResponse } from '../dto/platform-video-metrics.contract';
import type { PlatformCommerceMetricsResponse } from '../dto/platform-commerce-metrics.contract';
import type { PlatformDeliveryMetricsResponse } from '../dto/platform-delivery-metrics.contract';
import { REPORT_WINDOW_DEFAULT_DAYS } from '../dto/platform-metrics-query.dto';
import {
  CONTENT_ACCESS_LOG_RETENTION_DAYS,
  QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS,
} from '../../learning/queue/phase2-maintenance.types';

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

/**
 * P64 Phase 4 §E.5 — the same per-request read ceiling
 * `AcademyReportsService` applies (`MAX_ACCESS_ROWS` / `MAX_EVENT_ROWS`):
 * a percentile or a per-reason breakdown is computed over at most this
 * many most-recent rows and the response says so via `truncated`.
 */
const MAX_OPS_SAMPLE_ROWS = 50_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number, now: Date): Date =>
  new Date(now.getTime() - days * DAY_MS);

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

  /** P64 Phase 4 §E.5 — video minutes per tier, assets per provider, processing health. Separate from `getOverview` on purpose (its contract is a fixed seven KPIs). */
  async getVideoOverview(platformOwnerId: string): Promise<PlatformVideoMetricsResponse> {
    const inventory = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.platformScaleRepository.videoInventory(tx),
    );

    const byTier = inventory.byTier.map((row) => ({
      tier: (row.tier === 'normal' || row.tier === 'premium' ? row.tier : 'none') as
        'normal' | 'premium' | 'none',
      assets: row.assets,
      storedMinutes: Math.round((row.seconds / 60) * 10) / 10,
      storedGb: Math.round((row.bytes / 1024 ** 3) * 100) / 100,
    }));

    const processing = { pending: 0, processing: 0, ready: 0, failed: 0 };
    for (const row of inventory.byProcessing) {
      if (row.status in processing) {
        processing[row.status as keyof typeof processing] = row.assets;
      }
    }

    return {
      totalVideoAssets: byTier.reduce((sum, row) => sum + row.assets, 0),
      totalStoredMinutes:
        Math.round(byTier.reduce((sum, row) => sum + row.storedMinutes, 0) * 10) / 10,
      totalStoredGb:
        Math.round(byTier.reduce((sum, row) => sum + row.storedGb, 0) * 100) / 100,
      byTier,
      byProvider: Object.fromEntries(
        inventory.byProvider.map((row) => [row.provider, row.assets]),
      ),
      processing,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * P64 Phase 4 §E.5 — `GET /platform-metrics/commerce?days=`: course-order
   * funnel, manual-review backlog and throughput, proof→approval latency,
   * refunds and recognised revenue for the trailing `days` window. Every
   * read runs under the platform owner's RLS context (`course_orders_
   * platform_select`, `payments_platform_review_select`, `payment_proofs_
   * platform_review_select`, `payment_reviews_platform_review_select`,
   * `course_order_refunds_platform_select`).
   */
  async getCommerceOverview(
    platformOwnerId: string,
    days: number = REPORT_WINDOW_DEFAULT_DAYS,
  ): Promise<PlatformCommerceMetricsResponse> {
    const now = new Date();
    const from = daysAgo(days, now);

    const [ordersByStatus, awaitingReview, reviewsByStatus, latency, refunds, revenue] =
      await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => [
        await this.platformScaleRepository.courseOrdersCreatedByStatus(tx, from),
        await this.platformScaleRepository.courseOrderPaymentsAwaitingReview(tx),
        await this.platformScaleRepository.courseOrderPaymentReviewsByStatus(tx, from),
        await this.platformScaleRepository.courseOrderApprovalLatency(
          tx,
          from,
          MAX_OPS_SAMPLE_ROWS,
        ),
        await this.platformScaleRepository.courseOrderRefundCounts(tx, from),
        await this.platformScaleRepository.paidOrderRevenueByCurrency(tx, from),
      ]);

    // Every `CourseOrderStatus` value, explicitly — an unmapped status
    // would silently vanish from `created`'s breakdown otherwise.
    const orders = {
      created: 0,
      draft: 0,
      pendingPayment: 0,
      paid: 0,
      expired: 0,
      refunded: 0,
      cancelled: 0,
    };
    const orderStatusKeys: Record<string, keyof typeof orders> = {
      draft: 'draft',
      pending_payment: 'pendingPayment',
      paid: 'paid',
      expired: 'expired',
      refunded: 'refunded',
      cancelled: 'cancelled',
    };
    for (const row of ordersByStatus) {
      const key = orderStatusKeys[row.status];
      if (key) orders[key] += row.orders;
      orders.created += row.orders;
    }

    const reviews = { approved: 0, rejected: 0 };
    for (const row of reviewsByStatus) {
      if (row.status in reviews)
        reviews[row.status as keyof typeof reviews] = row.reviews;
    }

    return {
      windowDays: days,
      orders,
      payments: {
        awaitingReview,
        approvedInWindow: reviews.approved,
        rejectedInWindow: reviews.rejected,
      },
      approvalLatencySeconds: {
        p50: latency.sampleSize === 0 ? null : latency.p50,
        p95: latency.sampleSize === 0 ? null : latency.p95,
        sampleSize: latency.sampleSize,
        truncated: latency.sampleSize >= MAX_OPS_SAMPLE_ROWS,
      },
      refunds: {
        requestedInWindow: refunds.requested,
        completedInWindow: refunds.completed,
      },
      revenue: {
        paidByCurrency: Object.fromEntries(
          revenue.map((row) => [row.currency, Math.round(row.minorUnits)]),
        ),
      },
      generatedAt: now.toISOString(),
    };
  }

  /**
   * P64 Phase 4 §E.5 — `GET /platform-metrics/delivery?days=`: protected-
   * content access decisions in the window, the video inventory (reusing
   * `getVideoOverview` verbatim) and the retention backlog (rows past
   * `CONTENT_ACCESS_LOG_RETENTION_DAYS` / `QUIZ_ATTEMPT_EVENTS_RETENTION_
   * DAYS` the Phase 2 sweep has not pruned yet). RLS: `content_access_log_
   * platform_select`, `quiz_attempt_events_platform_select`,
   * `media_assets_platform_select`.
   */
  async getDeliveryOverview(
    platformOwnerId: string,
    days: number = REPORT_WINDOW_DEFAULT_DAYS,
  ): Promise<PlatformDeliveryMetricsResponse> {
    const now = new Date();
    const from = daysAgo(days, now);

    const [decisions, backlog] = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => [
        await this.platformScaleRepository.contentAccessDecisions(
          tx,
          from,
          MAX_OPS_SAMPLE_ROWS,
        ),
        await this.platformScaleRepository.retentionBacklog(
          tx,
          daysAgo(CONTENT_ACCESS_LOG_RETENTION_DAYS, now),
          daysAgo(QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS, now),
        ),
      ],
    );
    const video = await this.getVideoOverview(platformOwnerId);

    let granted = 0;
    let refused = 0;
    let sampled = 0;
    const refusedByReason: Record<string, number> = {};
    for (const row of decisions) {
      sampled += row.rows;
      if (row.result === 'granted') {
        granted += row.rows;
        continue;
      }
      refused += row.rows;
      const reason = row.reason ?? 'other';
      refusedByReason[reason] = (refusedByReason[reason] ?? 0) + row.rows;
    }

    return {
      windowDays: days,
      grants: {
        granted,
        refused,
        refusedByReason,
        truncated: sampled >= MAX_OPS_SAMPLE_ROWS,
      },
      video,
      retention: {
        contentAccessLogRowsPastWindow: backlog.contentAccessLogRows,
        quizAttemptEventsPastWindow: backlog.quizAttemptEventRows,
      },
      generatedAt: now.toISOString(),
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
