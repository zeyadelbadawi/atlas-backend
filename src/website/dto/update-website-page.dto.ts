/**
 * `PATCH academies/:id/website/pages/:pageId` request — matches
 * `UpdateWebsitePagePayload` (`website.types.ts`) exactly. Only the
 * top-level shape is declared here (satisfying the global `ValidationPipe`'s
 * `whitelist`/`forbidNonWhitelisted` requirement that every accepted field
 * be a known DTO property) — the real, security-critical structural
 * validation of `seo`/`sections` happens against the Zod schemas in
 * `validation/` inside `WebsitePagesService`, matching how `MediaService`
 * does its own real validation (data-URL parsing, magic-byte detection)
 * past the DTO boundary rather than inside a class-validator decorator.
 */
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  MAX_PAGE_SLUG_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MIN_PAGE_SLUG_LENGTH,
  PAGE_SLUG_REGEX,
} from '../constants/website.constants';

export class UpdateWebsitePageDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PAGE_TITLE_LENGTH)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MinLength(MIN_PAGE_SLUG_LENGTH)
  @MaxLength(MAX_PAGE_SLUG_LENGTH)
  @Matches(PAGE_SLUG_REGEX, { message: 'errors.website.invalidSlug' })
  readonly slug?: string;

  @IsOptional()
  @IsBoolean()
  readonly visible?: boolean;

  @IsOptional()
  @IsObject()
  readonly seo?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  readonly sections?: unknown[];
}
