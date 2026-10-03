/**
 * Cursor-feed query shared by `GET academies/:id/activity` (tenant) and
 * `GET audit-log/feed` (Platform Owner). The global `ValidationPipe` runs
 * with `forbidNonWhitelisted`, so every accepted key is declared here.
 *
 * `category` expands to the catalogue's actions for that category and is
 * intersected with whatever else restricts the feed (the tenant visibility
 * list, an exact `action`), never widened by it.
 */
import { Type } from 'class-transformer';
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
import { AUDIT_CATEGORIES, type AuditCategory } from '../catalog/audit-event-catalog';

export const DEFAULT_AUDIT_FEED_LIMIT = 25;
export const MAX_AUDIT_FEED_LIMIT = 100;

export class AuditFeedQueryDto {
  /** Opaque cursor from the previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AUDIT_FEED_LIMIT)
  readonly limit?: number;

  @IsOptional()
  @IsIn(AUDIT_CATEGORIES)
  readonly category?: AuditCategory;

  /** Exact action, e.g. `website_page.published`. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9_.]+$/)
  readonly action?: string;

  @IsOptional()
  @IsUUID()
  readonly actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  readonly targetType?: string;

  /** Inclusive lower bound on `occurredAt`. */
  @IsOptional()
  @IsISO8601()
  readonly occurredFrom?: string;

  /** Inclusive upper bound on `occurredAt`. */
  @IsOptional()
  @IsISO8601()
  readonly occurredTo?: string;

  /** Matches the target's label or the actor's name, case-insensitively. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly search?: string;
}

/** The Platform feed additionally filters by tenant. */
export class PlatformAuditFeedQueryDto extends AuditFeedQueryDto {
  @IsOptional()
  @IsUUID()
  readonly organizationId?: string;

  @IsOptional()
  @IsUUID()
  readonly academyId?: string;
}
