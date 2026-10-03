/**
 * `PUT academies/:id/visual-identity` — the one save for an Academy's
 * visual identity: its name, logo, favicon and website colours together.
 *
 * Everything is optional; what is present is saved in one transaction.
 * `logo`/`favicon` accept `null` to remove them (the branding PATCH, which
 * ignores absent fields, never could). `brand` is the same partial merge
 * `PATCH website/configuration` takes, validated by the same schema.
 */
import {
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  IsFaviconReference,
  IsLogoReference,
} from '../../academy/dto/update-academy-branding.dto';
import { MAX_ACADEMY_NAME_LENGTH } from '../../academy/dto/create-academy.dto';

export class SaveVisualIdentityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ACADEMY_NAME_LENGTH)
  readonly name?: string;

  @IsOptional()
  @IsString()
  @IsLogoReference()
  readonly logo?: string | null;

  @IsOptional()
  @IsString()
  @IsFaviconReference()
  readonly favicon?: string | null;

  @IsOptional()
  @IsObject()
  readonly brand?: Record<string, unknown>;

  /**
   * The website configuration's `updatedAt` the editor loaded. When it no
   * longer matches, nothing is saved (409 `stale_resource_version`).
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  readonly expectedUpdatedAt?: string;
}
