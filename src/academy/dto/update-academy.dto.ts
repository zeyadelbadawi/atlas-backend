/**
 * `PATCH /academies/:id` request — matches `UpdateAcademyPayload`
 * (`academy.types.ts`) field-for-field. Deliberately has no
 * `organizationId` field — `organization_id` can never be reassigned
 * through this endpoint (enforced twice over: it isn't accepted here at
 * all, and even if it were, `academies_tenant_update`'s RLS `WITH CHECK`
 * would reject any row whose `organization_id` no longer matches the
 * active tenant context).
 */
import {
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ACADEMY_SLUG_REGEX,
  MAX_ACADEMY_DESCRIPTION_LENGTH,
  MAX_ACADEMY_NAME_LENGTH,
  MAX_ACADEMY_SLUG_LENGTH,
} from './create-academy.dto';
import { ACADEMY_STATUS_VALUES } from './academy.constants';

/** Matches `AcademyAddress` (`academy.types.ts`) — a partial merge into the stored `address` JSON, never a full overwrite (see `AcademiesService.update`). */
export class AcademyAddressInputDto {
  @IsOptional()
  @IsString()
  readonly street?: string;

  @IsOptional()
  @IsString()
  readonly city?: string;

  @IsOptional()
  @IsString()
  readonly state?: string;

  @IsOptional()
  @IsString()
  readonly postalCode?: string;

  @IsOptional()
  @IsString()
  readonly country?: string;
}

export class UpdateAcademyDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_SLUG_LENGTH)
  @Matches(ACADEMY_SLUG_REGEX, { message: 'errors.academy.invalidSlug' })
  readonly slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_DESCRIPTION_LENGTH)
  readonly description?: string;

  @IsOptional()
  @IsEmail()
  readonly contactEmail?: string;

  @IsOptional()
  @IsString()
  readonly contactPhone?: string;

  @IsOptional()
  @IsUrl()
  readonly website?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AcademyAddressInputDto)
  readonly address?: AcademyAddressInputDto;

  @IsOptional()
  @IsString()
  readonly language?: string;

  @IsOptional()
  @IsString()
  readonly timezone?: string;

  @IsOptional()
  @IsString()
  readonly currency?: string;

  @IsOptional()
  @IsIn(ACADEMY_STATUS_VALUES)
  readonly status?: (typeof ACADEMY_STATUS_VALUES)[number];
}
