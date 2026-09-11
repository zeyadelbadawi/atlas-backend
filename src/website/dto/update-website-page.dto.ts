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
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
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

  /**
   * The `version` this edit was based on.
   *
   * Optional so that a caller predating this field is not hard-failed on a
   * token it has no way to supply — it simply keeps the old
   * last-write-wins behaviour. Every Atlas editor sends it, and when it IS
   * sent a mismatch is refused with a 409 rather than overwriting whoever
   * saved in between. See `WebsitePagesService.update`.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly expectedVersion?: number;
}
