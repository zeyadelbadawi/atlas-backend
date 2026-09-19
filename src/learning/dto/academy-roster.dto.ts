/**
 * P64 Phase 1 — DTOs for the academy student roster, enrollment lifecycle
 * and registration-policy endpoints (`AcademyStudentsController`).
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MAX_PAGE_SIZE } from '../../common/dto/collection-query.dto';

export const ROSTER_STATUS_FILTERS = [
  'active',
  'inactive',
  'pending',
  'blocked',
] as const;
export const ROSTER_SORT_FIELDS = ['joinedAt', 'lastActivityAt', 'name'] as const;

export class AcademyRosterQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  readonly pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  readonly search?: string;

  @IsOptional()
  @IsIn(ROSTER_STATUS_FILTERS)
  readonly status?: (typeof ROSTER_STATUS_FILTERS)[number];

  @IsOptional()
  @IsString()
  readonly courseId?: string;

  @IsOptional()
  @IsIn(ROSTER_SORT_FIELDS)
  readonly sortBy?: (typeof ROSTER_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(['asc', 'desc'])
  readonly sortDir?: 'asc' | 'desc';
}

export class BlockStudentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reason?: string;
}

export class ManualEnrollDto {
  @IsNotEmpty()
  @IsString()
  readonly courseId!: string;

  @IsOptional()
  @IsISO8601()
  readonly expiresAt?: string;
}

export const REVOKE_REASONS = ['manual', 'membership_ended', 'suspended'] as const;

export class RevokeEnrollmentDto {
  @IsOptional()
  @IsIn(REVOKE_REASONS)
  readonly reason?: (typeof REVOKE_REASONS)[number];
}

export class UpdateEnrollmentExpiryDto {
  /** `null` clears the expiry (access does not end on its own). */
  @ValidateIf((o: UpdateEnrollmentExpiryDto) => o.expiresAt !== null)
  @IsISO8601()
  readonly expiresAt!: string | null;
}

export class UpdateRegistrationPolicyDto {
  @IsIn(['open', 'invite', 'approval'])
  readonly registrationPolicy!: 'open' | 'invite' | 'approval';
}

export class CreateAcademyInviteDto {
  @IsOptional()
  @IsEmail()
  readonly email?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  readonly maxUses?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  readonly expiresInDays?: number;
}

export class ApproveStudentDto {
  @IsOptional()
  @IsBoolean()
  readonly notify?: boolean;
}
