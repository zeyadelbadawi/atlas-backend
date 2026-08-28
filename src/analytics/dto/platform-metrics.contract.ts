/**
 * `GET /platform-metrics` response — matches `PlatformMetricsOverview`
 * (`platform-metrics.types.ts`) field-for-field. Carries EXACTLY the seven
 * KPIs that type names — no additional field, per that type's own doc
 * comment ("no additional KPIs are invented").
 */
export interface PlatformMetricTrendResponse {
  readonly value: number;
  readonly changePercent?: number;
}

export interface PlatformRevenueMetricResponse {
  readonly amount: number;
  readonly currency: string;
  readonly changePercent?: number;
}

export interface PlatformMetricsOverviewResponse {
  readonly totalAcademies: PlatformMetricTrendResponse;
  readonly totalUsers: PlatformMetricTrendResponse;
  readonly activeCourses: PlatformMetricTrendResponse;
  readonly revenue: PlatformRevenueMetricResponse;
  readonly systemHealthPercent: number;
  readonly storageUsagePercent: number;
  readonly apiUptimePercent: number;
  readonly generatedAt: string;
}
