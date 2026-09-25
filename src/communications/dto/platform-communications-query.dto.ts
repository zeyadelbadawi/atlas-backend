/** Query for the C7 console: a window in days, plus cursor pagination for the suppression list. */
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator';

const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);

export class PlatformCommunicationsQueryDto {
  /** Trailing window for the aggregates. Bounded so a caller cannot ask for a full-table scan. */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(90)
  readonly days?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  readonly limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly cursor?: string;
}
