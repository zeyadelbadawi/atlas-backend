/**
 * Query shapes for the Zoom Operations Center list endpoints.
 *
 * Filtering happens in the DATABASE, not the browser: an operations
 * console over every academy and every session must never ship the whole
 * table to the client and narrow it there. Each field below maps to a
 * real stored column — nothing filters on a value Atlas does not persist.
 */
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

/** Mirrors `LiveProviderConnectionStatus`. No invented states. */
export const ZOOM_CONNECTION_STATUSES = [
  'not_connected',
  'connected',
  'expired',
  'revoked',
  'error',
  'reconnect_required',
] as const;

/** Mirrors `LiveSessionStatus`. No invented states. */
export const ZOOM_SESSION_STATUSES = [
  'draft',
  'scheduled',
  'live',
  'ended',
  'cancelled',
  'failed',
] as const;

/** `?issuesOnly=true` arrives as a string on a query string. */
const toBoolean = ({ value }: { value: unknown }): boolean | undefined =>
  value === undefined ? undefined : value === true || value === 'true';

export class PlatformZoomConnectionsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly organizationId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsIn(ZOOM_CONNECTION_STATUSES, { message: 'validation:invalid' })
  readonly status?: (typeof ZOOM_CONNECTION_STATUSES)[number];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  readonly issuesOnly?: boolean;
}

export class PlatformZoomSessionsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly organizationId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsIn(ZOOM_SESSION_STATUSES, { message: 'validation:invalid' })
  readonly status?: (typeof ZOOM_SESSION_STATUSES)[number];

  @IsOptional()
  @IsISO8601(undefined, { message: 'validation:invalid' })
  @Type(() => String)
  readonly from?: string;

  @IsOptional()
  @IsISO8601(undefined, { message: 'validation:invalid' })
  @Type(() => String)
  readonly to?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  readonly atRiskOnly?: boolean;

  @IsOptional()
  @IsString()
  readonly providerKey?: string;
}

/** Reconciliation states the Attendance page can filter on (all derived). */
export const ZOOM_RECONCILIATION_STATES = [
  'reconciled',
  'pending',
  'failing',
  'not_due',
] as const;

/** Recording lifecycle, mirroring `LiveSessionRecordingStatus`. */
export const ZOOM_RECORDING_STATUSES = [
  'requested',
  'processing',
  'available',
  'failed',
] as const;

/** Event processing states, mirroring `LiveProviderEventStatus`. */
export const ZOOM_EVENT_STATUSES = ['received', 'processed', 'unmatched', 'failed'] as const;

export class PlatformZoomAttendanceQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly organizationId?: string;

  @IsOptional()
  @IsIn(ZOOM_RECONCILIATION_STATES, { message: 'validation:invalid' })
  readonly state?: (typeof ZOOM_RECONCILIATION_STATES)[number];
}

export class PlatformZoomRecordingsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly organizationId?: string;

  @IsOptional()
  @IsIn(ZOOM_RECORDING_STATUSES, { message: 'validation:invalid' })
  readonly status?: (typeof ZOOM_RECORDING_STATUSES)[number];
}

export class PlatformZoomEventsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsIn(ZOOM_EVENT_STATUSES, { message: 'validation:invalid' })
  readonly status?: (typeof ZOOM_EVENT_STATUSES)[number];

  @IsOptional()
  @IsString()
  readonly eventType?: string;
}

export class PlatformZoomActivityQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly academyId?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'validation:invalid' })
  readonly organizationId?: string;

  @IsOptional()
  @IsString()
  readonly action?: string;
}
