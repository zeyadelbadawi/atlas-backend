/**
 * `GET /analytics/{overview,time-series/:metric,breakdown/:dimension}`
 * query — matches `AnalyticsQuery`'s `dateRange?: {from, to}` exactly
 * (`AnalyticsService.toParams`: `{from: dateRange.from, to: dateRange.to}`,
 * both flattened top-level query params, never a nested object). Both
 * optional — see `resolveDateRange`'s own doc comment for the "omit both,
 * get the last 30 days" default.
 */
import { IsOptional, Matches } from 'class-validator';

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class AnalyticsQueryDto {
  @IsOptional()
  @Matches(ISO_DATE_ONLY, { message: 'errors.analytics.invalidDateRange' })
  readonly from?: string;

  @IsOptional()
  @Matches(ISO_DATE_ONLY, { message: 'errors.analytics.invalidDateRange' })
  readonly to?: string;
}
