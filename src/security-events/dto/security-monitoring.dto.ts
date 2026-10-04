/**
 * W3 — query for the Platform Owner's OTP & Security Monitoring page
 * (`GET platform-security/summary`, `GET platform-security/events`).
 * Closed vocabularies and bounded windows only.
 */
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsIP,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SecurityEventType } from '@prisma/client';

const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === '' ? undefined : Number(value);
const blankToUndefined = ({ value }: { value: unknown }): unknown =>
  value === '' ? undefined : value;

export const SECURITY_EVENT_TYPES = Object.values(SecurityEventType);

export class SecurityMonitoringQueryDto {
  /** Trailing window in days; bounded by the 90-day retention. */
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(90)
  readonly days?: number;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(['management', 'academy'])
  readonly surface?: 'management' | 'academy';

  @IsOptional()
  @Transform(blankToUndefined)
  @IsUUID()
  readonly academyId?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(SECURITY_EVENT_TYPES)
  readonly type?: SecurityEventType;

  /** Hashed server-side and compared; never stored, logged or echoed. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsEmail()
  @MaxLength(320)
  readonly email?: string;

  /** Hashed server-side (per month in the window) and compared; never stored or echoed. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIP()
  readonly ip?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  readonly limit?: number;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  readonly cursor?: string;
}
