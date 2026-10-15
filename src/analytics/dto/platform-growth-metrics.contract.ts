/**
 * B0-ANL-04 (part 3) — `GET /platform-metrics/growth`. Matches
 * `PlatformGrowthMetrics` (atlas frontend,
 * `features/platform/services/PlatformMetricsService.ts`) field-for-field.
 */
import type {
  GrowthCohortRow,
  GrowthSourceRow,
} from '../repositories/platform-growth.repository';

export interface PlatformGrowthMetricsResponse {
  /** Always `Africa/Cairo`; weeks start on Monday. */
  readonly timeZone: string;
  readonly weeks: number;
  /** Oldest first; every week in the window is present (zeros included). */
  readonly cohorts: readonly GrowthCohortRow[];
  readonly totals: Omit<GrowthCohortRow, 'weekStart'>;
  readonly sources: readonly GrowthSourceRow[];
  /** Internal (test/demo/staff) organizations are never counted. */
  readonly excludesInternalOrganizations: true;
  readonly generatedAt: string;
}
