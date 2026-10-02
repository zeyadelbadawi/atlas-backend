import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import type { AlertSeverity, MetricRange } from './observability.contract';

const RANGES: readonly MetricRange[] = ['1h', '6h', '24h', '7d', '30d'];

export class RangeQueryDto {
  @IsOptional()
  @IsIn(RANGES)
  readonly range?: MetricRange;
}

export class WebVitalsQueryDto {
  @IsOptional()
  @IsIn(['24h', '7d'])
  readonly range?: '24h' | '7d';
}

export class AlertsQueryDto extends RangeQueryDto {
  @IsOptional()
  @IsIn(['all', 'active', 'resolved'])
  readonly status?: 'all' | 'active' | 'resolved';

  @IsOptional()
  @IsIn(['critical', 'warning', 'info'])
  readonly severity?: AlertSeverity;

  /** Rule names are identifiers; anything else never reaches a query. */
  @IsOptional()
  @Matches(/^[A-Za-z_][A-Za-z0-9_:]{0,127}$/)
  readonly rule?: string;
}

export class ArmSyntheticAlertDto {
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(30)
  readonly minutes!: number;
}
