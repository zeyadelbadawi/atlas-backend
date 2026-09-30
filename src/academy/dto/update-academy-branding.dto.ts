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
import {
  IsOptional,
  IsString,
  MaxLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import {
  LEGACY_DATA_IMAGE_PATTERN,
  MEDIA_ASSET_PATH_PATTERN,
} from '../../website/constants/website.constants';
import { MAX_ACADEMY_NAME_LENGTH } from './create-academy.dto';

/**
 * Theme 1 plan Phase 8 — the logo is rendered on the public website, in
 * emails and (fetched server-side) on certificates, so a value that is not
 * an image reference is refused here rather than stored: an uploaded media
 * path, an http(s) URL, or a legacy inline raster (`data:image/…;base64`,
 * how logos were saved before media uploads — re-sent unchanged whenever
 * the branding form is saved). `javascript:`, `blob:`, other schemes and
 * malformed values are rejected. An empty value is accepted, as before.
 */
function IsLogoReference(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isLogoReference',
      target: object.constructor,
      propertyName,
      options: { message: 'validation:invalidUrl', ...options },
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null || value === '') return true;
          if (typeof value !== 'string') return false;
          if (MEDIA_ASSET_PATH_PATTERN.test(value)) return true;
          if (value.startsWith('data:')) return LEGACY_DATA_IMAGE_PATTERN.test(value);
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
          } catch {
            return false;
          }
        },
      },
    });
  };
}

export class UpdateAcademyBrandingDto {
  @IsOptional()
  @IsString()
  @IsLogoReference()
  readonly logo?: string;

  @IsOptional()
  @IsString()
  readonly favicon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly name?: string;
}
