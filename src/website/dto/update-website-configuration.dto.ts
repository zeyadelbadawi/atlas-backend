/**
 * `PATCH academies/:id/website/configuration` request — matches
 * `UpdateWebsiteConfigurationPayload` (`website.types.ts`) exactly: every
 * field optional, `brand`/`seo` are partial merges (see
 * `WebsiteConfigurationService.updateConfiguration`), `navigation`/
 * `header`/`footer` are full replaces. See `UpdateWebsitePageDto`'s doc
 * comment for why deep validation happens in the service, not here.
 */
import { IsArray, IsIn, IsObject, IsOptional } from 'class-validator';
import { SELECTABLE_WEBSITE_THEME_KEYS } from '../constants/website.constants';

export class UpdateWebsiteConfigurationDto {
  /** Only a selectable theme; Themes 2–5 are retired (`RETIRED_WEBSITE_THEME_KEYS`). */
  @IsOptional()
  @IsIn(SELECTABLE_WEBSITE_THEME_KEYS)
  readonly themeKey?: (typeof SELECTABLE_WEBSITE_THEME_KEYS)[number];

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
