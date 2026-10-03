/**
 * W3 — query for the Platform Owner's Academy Email Activity page
 * (`GET platform-communications/email-activity[/summary]`).
 *
 * Every filter is closed or bounded: the academy id is a UUID, the status
 * and catalogue key come from fixed vocabularies, the window is at most the
 * outbox's own 90-day retention, and the page size is capped.
 */
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { COMMUNICATION_EVENT_KEYS } from '../catalog/communication-catalog';
import { EMAIL_ACTIVITY_STATUSES } from '../utils/email-activity-status.util';

const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);
const blankToUndefined = ({ value }: { value: unknown }): unknown =>
  value === '' ? undefined : value;

export class AcademyEmailActivityQueryDto {
  @IsOptional()
  @Transform(blankToUndefined)
  @IsUUID()
  readonly academyId?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(EMAIL_ACTIVITY_STATUSES)
  readonly status?: (typeof EMAIL_ACTIVITY_STATUSES)[number];

  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(COMMUNICATION_EVENT_KEYS)
  readonly key?: string;

  /** Inclusive lower bound (ISO 8601). Defaults to 30 days before `to`. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsISO8601({ strict: true })
  readonly from?: string;

  /** Exclusive upper bound (ISO 8601). Defaults to now. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsISO8601({ strict: true })
  readonly to?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly limit?: number;

  /** Opaque keyset cursor returned as `nextCursor`. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  readonly cursor?: string;
}
