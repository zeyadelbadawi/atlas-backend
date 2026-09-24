/**
 * `GET /platform-metrics/commerce|delivery` query — the window in days.
 * The same 1–90 bound and 30-day default as
 * `AcademyReportsQueryDto` (`src/dashboard/dto/academy-reports-query.dto.ts`),
 * for the same reason: one request can never scan more than a quarter.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  REPORT_WINDOW_DEFAULT_DAYS,
  REPORT_WINDOW_MAX_DAYS,
} from '../../dashboard/dto/academy-reports-query.dto';

export { REPORT_WINDOW_DEFAULT_DAYS, REPORT_WINDOW_MAX_DAYS };

export class PlatformMetricsWindowQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REPORT_WINDOW_MAX_DAYS)
  readonly days?: number;
}
