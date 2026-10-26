/**
 * B3 — site announcement request DTOs (class-validator).
 *
 * Text is plain (markup refused); URLs are `https://…` or a site-relative
 * `/…` path. What a LIVE announcement additionally needs (a language, a
 * pop-up title) is checked on activation and on every edit of an active
 * one → 422 (`SiteAnnouncementsService`).
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { IsHttpsOrSiteRelativeUrl } from '../../common/validation/safe-url.util';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_LIMITS,
  ANNOUNCEMENT_LOCALES,
  ANNOUNCEMENT_PAGE_PATTERN,
  ANNOUNCEMENT_POPUP_FREQUENCIES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_SURFACES,
  ANNOUNCEMENT_TONES,
  type AnnouncementLocale,
} from '../site-announcement-rules';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ListSiteAnnouncementsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_SURFACES)
  readonly surface?: (typeof ANNOUNCEMENT_SURFACES)[number];

  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES)
  readonly status?: (typeof ANNOUNCEMENT_STATUSES)[number];

  @IsOptional()
  @IsIn(['updatedAt', 'priority', 'name'])
  declare readonly sortBy?: 'updatedAt' | 'priority' | 'name';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  declare readonly search?: string;
}

export class AnnouncementContentDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(ANNOUNCEMENT_LIMITS.title.max)
  readonly title?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(ANNOUNCEMENT_LIMITS.body.max)
  readonly body?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(ANNOUNCEMENT_LIMITS.ctaLabel.max)
  readonly ctaLabel?: string | null;
}

/** Each language given replaces that language wholesale; `null` clears it; absent keeps it. */
export class AnnouncementContentsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementContentDto)
  readonly en?: AnnouncementContentDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementContentDto)
  readonly ar?: AnnouncementContentDto | null;
}

class SiteAnnouncementFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(ANNOUNCEMENT_LIMITS.name.min)
  @MaxLength(ANNOUNCEMENT_LIMITS.name.max)
  readonly name?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_TONES)
  readonly tone?: (typeof ANNOUNCEMENT_TONES)[number];

  @IsOptional()
  @IsISO8601({ strict: true })
  readonly startsAt?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  readonly endsAt?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementContentsDto)
  readonly content?: AnnouncementContentsDto;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @IsHttpsOrSiteRelativeUrl()
  readonly ctaUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @IsHttpsOrSiteRelativeUrl()
  readonly imageUrl?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ANNOUNCEMENT_LIMITS.pages.max)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(ANNOUNCEMENT_LIMITS.pages.itemMax, { each: true })
  @Matches(ANNOUNCEMENT_PAGE_PATTERN, { each: true })
  readonly pages?: string[];

  @IsOptional()
  @IsBoolean()
  readonly dismissible?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ANNOUNCEMENT_LIMITS.popupDelaySeconds.min)
  @Max(ANNOUNCEMENT_LIMITS.popupDelaySeconds.max)
  readonly popupDelaySeconds?: number;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_POPUP_FREQUENCIES)
  readonly popupFrequency?: (typeof ANNOUNCEMENT_POPUP_FREQUENCIES)[number];

  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES)
  readonly audience?: (typeof ANNOUNCEMENT_AUDIENCES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(ANNOUNCEMENT_LIMITS.priority.min)
  @Max(ANNOUNCEMENT_LIMITS.priority.max)
  readonly priority?: number;
}

export class CreateSiteAnnouncementDto extends SiteAnnouncementFieldsDto {
  @Transform(trim)
  @IsString()
  @MinLength(ANNOUNCEMENT_LIMITS.name.min)
  @MaxLength(ANNOUNCEMENT_LIMITS.name.max)
  declare readonly name: string;

  @IsIn(ANNOUNCEMENT_SURFACES)
  readonly surface!: (typeof ANNOUNCEMENT_SURFACES)[number];
}

export class UpdateSiteAnnouncementDto extends SiteAnnouncementFieldsDto {
  /** Optimistic concurrency: the `version` the editor last read. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_SURFACES)
  readonly surface?: (typeof ANNOUNCEMENT_SURFACES)[number];
}

export class SiteAnnouncementVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;
}

export class PublicSiteAnnouncementsQueryDto {
  @IsIn(['marketing'])
  readonly surface!: 'marketing';

  @IsOptional()
  @IsIn(ANNOUNCEMENT_LOCALES)
  readonly locale?: AnnouncementLocale;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly path?: string;
}

export class DashboardSiteAnnouncementsQueryDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_LOCALES)
  readonly locale?: AnnouncementLocale;
}

export const ANNOUNCEMENT_EVENT_TYPES = ['view', 'click', 'dismiss'] as const;
export type AnnouncementEventType = (typeof ANNOUNCEMENT_EVENT_TYPES)[number];

export class SiteAnnouncementEventDto {
  @IsIn(ANNOUNCEMENT_EVENT_TYPES)
  readonly type!: AnnouncementEventType;
}

/** Unknown or malformed ids on the event route are ignored (204), never refused. */
export function isAnnouncementId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
