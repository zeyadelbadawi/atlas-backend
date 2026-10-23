/**
 * B2 — Founding Academies: Platform Owner request DTOs (class-validator).
 * Every write carries only what the Platform Owner decides; prices are
 * never accepted from a client — the locked price is always the plan's
 * live annual catalog price at the moment of the action.
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export const FOUNDING_STATUSES = ['active', 'revoked', 'ended'] as const;
export const FOUNDING_SORT_FIELDS = [
  'seatNumber',
  'createdAt',
  'lockEndsAt',
  'organizationName',
] as const;
export type FoundingSortField = (typeof FOUNDING_SORT_FIELDS)[number];

export const FOUNDING_NOTES_MAX = 4000;
export const FOUNDING_REASON_MAX = 500;
export const FOUNDING_EMAIL_SUBJECT_MAX = 150;
export const FOUNDING_EMAIL_BODY_MAX = 5000;

export class ListFoundingMembershipsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(FOUNDING_STATUSES)
  readonly status?: (typeof FOUNDING_STATUSES)[number];

  @IsOptional()
  @IsIn(FOUNDING_SORT_FIELDS)
  declare readonly sortBy?: FoundingSortField;

  @IsOptional()
  @MaxLength(200)
  declare readonly search?: string;
}

export class FoundingQuoteQueryDto {
  @IsUUID()
  readonly organizationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  readonly planKey!: string;
}

export class FoundingCandidatesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly search?: string;
}

export class CreateFoundingMembershipDto {
  @IsUUID()
  readonly organizationId!: string;

  /** The catalog plan whose annual price is locked (e.g. `growth`). */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  readonly planKey!: string;

  /** Defaults to now. Within a year either side of today. */
  @IsOptional()
  @IsISO8601({ strict: true })
  readonly lockStartsAt?: string;

  @IsOptional()
  @IsUUID()
  readonly sourceContactSubmissionId?: string;

  /** Archive the linked founding request (marks it handled). */
  @IsOptional()
  @IsBoolean()
  readonly markContactHandled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(FOUNDING_NOTES_MAX)
  readonly notes?: string;
}

export class UpdateFoundingMembershipDto {
  /** Optimistic concurrency: the `updatedAt` the editor last read. */
  @IsISO8601({ strict: true })
  readonly expectedUpdatedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(FOUNDING_NOTES_MAX)
  readonly notes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999)
  readonly conciergeHoursUsed?: number;

  /** A family change: re-locks at THAT plan's current annual catalog price. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  readonly planKey?: string;
}

export class RevokeFoundingMembershipDto {
  // Trim first so a whitespace-only reason fails MinLength.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(FOUNDING_REASON_MAX)
  readonly reason!: string;
}

export const FOUNDING_EMAIL_AUDIENCES = ['all_active', 'selected'] as const;
export type FoundingEmailAudience = (typeof FOUNDING_EMAIL_AUDIENCES)[number];

export class FoundingEmailAudienceDto {
  @IsIn(FOUNDING_EMAIL_AUDIENCES)
  readonly audience!: FoundingEmailAudience;

  /** Required for `selected` (one or more); ignored for `all_active`. */
  @IsOptional()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly membershipIds?: string[];
}

export class SendFoundingEmailDto extends FoundingEmailAudienceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(FOUNDING_EMAIL_SUBJECT_MAX)
  readonly subjectEn!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(FOUNDING_EMAIL_BODY_MAX)
  readonly bodyEn!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(FOUNDING_EMAIL_SUBJECT_MAX)
  readonly subjectAr!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(FOUNDING_EMAIL_BODY_MAX)
  readonly bodyAr!: string;

  /**
   * The recipient count the Platform Owner confirmed in the preview. The
   * send is refused (409) when the audience changed since, so a confirm
   * never mails more people than the dialog said.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  readonly confirmRecipientCount!: number;
}
