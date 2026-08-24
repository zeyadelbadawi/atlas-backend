/**
 * `PATCH /academies/:id/branding` request — matches
 * `UpdateAcademyBrandingPayload` (`academy.types.ts`) field-for-field.
 * `logo`/`favicon` are stored as `logo_url`/`favicon_url` — validated as
 * plain strings, not `@IsUrl()`, matching `academy.constants.ts`'s own
 * upload flow (`MAX_LOGO_FILE_SIZE`/`ALLOWED_LOGO_TYPES`), which implies
 * these arrive as already-hosted URLs from a prior upload step outside
 * P3's scope (media/storage — Phase P13), not raw file data through this
 * endpoint.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_ACADEMY_NAME_LENGTH } from './create-academy.dto';

export class UpdateAcademyBrandingDto {
  @IsOptional()
  @IsString()
  readonly logo?: string;

  @IsOptional()
  @IsString()
  readonly favicon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly name?: string;
}
