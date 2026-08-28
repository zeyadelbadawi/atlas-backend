/**
 * `GET /analytics/{overview,time-series/:metric,breakdown/:dimension}`
 * responses — match `AnalyticsOverview`/`AnalyticsTimeSeries`/
 * `AnalyticsBreakdown` (`analytics.types.ts`) field-for-field. Carries
 * exactly the four `AnalyticsOverview` KPIs that type names, per its own
 * doc comment ("no additional KPI is invented").
 */
export interface AnalyticsMetricTrendResponse {
  readonly value: number;
  readonly changePercent?: number;
}

export interface AnalyticsOverviewResponse {
  readonly totalUsers: AnalyticsMetricTrendResponse;
  readonly activeUsers: AnalyticsMetricTrendResponse;
  readonly engagementRatePercent: number;
  readonly engagementRateChangePercent?: number;
  readonly revenue: AnalyticsMetricTrendResponse;
  readonly revenueCurrency: string;
  readonly generatedAt: string;
}

export interface AnalyticsTimeSeriesPointResponse {
  readonly date: string;
  readonly value: number;
}

export interface AnalyticsTimeSeriesResponse {
  readonly metric: string;
  readonly points: readonly AnalyticsTimeSeriesPointResponse[];
}

export interface AnalyticsBreakdownItemResponse {
  readonly label: string;
  readonly value: number;
}

export interface AnalyticsBreakdownResponse {
  readonly dimension: string;
  readonly items: readonly AnalyticsBreakdownItemResponse[];
}

/** The only `:metric` values the real frontend contract ever requests (`AnalyticsPage.tsx`, grep-verified) — an unsupported metric 404s rather than fabricating a series for a name nothing calls. */
export const SUPPORTED_TIME_SERIES_METRICS = ['users', 'engagement', 'revenue'] as const;
export type SupportedTimeSeriesMetric = (typeof SUPPORTED_TIME_SERIES_METRICS)[number];

/** The only `:dimension` value the real frontend contract ever requests (`revenueByPlanQuery` in `AnalyticsPage.tsx`). */
export const SUPPORTED_BREAKDOWN_DIMENSIONS = ['plan'] as const;
export type SupportedBreakdownDimension = (typeof SUPPORTED_BREAKDOWN_DIMENSIONS)[number];
