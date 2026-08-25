/**
 * `PATCH academies/:id/website/configuration` request — matches
 * `UpdateWebsiteConfigurationPayload` (`website.types.ts`) exactly: every
 * field optional, `brand`/`seo` are partial merges (see
 * `WebsiteConfigurationService.updateConfiguration`), `navigation`/
 * `header`/`footer` are full replaces. See `UpdateWebsitePageDto`'s doc
 * comment for why deep validation happens in the service, not here.
 */
import { IsArray, IsIn, IsObject, IsOptional } from 'class-validator';
import { WEBSITE_THEME_KEYS } from '../constants/website.constants';

export class UpdateWebsiteConfigurationDto {
  @IsOptional()
  @IsIn(WEBSITE_THEME_KEYS)
  readonly themeKey?: (typeof WEBSITE_THEME_KEYS)[number];

  @IsOptional()
  @IsObject()
  readonly brand?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  readonly seo?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  readonly navigation?: unknown[];

  @IsOptional()
  @IsObject()
  readonly header?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  readonly footer?: Record<string, unknown>;
}
