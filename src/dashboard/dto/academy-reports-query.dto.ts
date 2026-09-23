/**
 * `GET academies/:id/reports/*` query — the reporting window in days.
 * Bounded (1–90) so a report can never scan more than one quarter of the
 * retained data in a single request; the default matches the dashboard's
 * 30-day framing.
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const REPORT_WINDOW_DEFAULT_DAYS = 30;
export const REPORT_WINDOW_MAX_DAYS = 90;

export class AcademyReportsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REPORT_WINDOW_MAX_DAYS)
  readonly days?: number;
}
