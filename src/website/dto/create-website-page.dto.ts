/** `POST academies/:id/website/pages` request — matches `CreateWebsitePagePayload` (`website.types.ts`) exactly: title + slug only. Always creates a `custom` page — there is no way to create a `core` page through this endpoint (core pages are provisioned once, automatically, by `WebsiteBootstrapService`). Structural bounds only here; the real slug-uniqueness/reserved-slug checks happen in `WebsitePagesService`. */
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  MAX_PAGE_SLUG_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  MIN_PAGE_SLUG_LENGTH,
  PAGE_SLUG_REGEX,
} from '../constants/website.constants';

export class CreateWebsitePageDto {
  @IsString()
  @MaxLength(MAX_PAGE_TITLE_LENGTH)
  readonly title!: string;

  @IsString()
  @MinLength(MIN_PAGE_SLUG_LENGTH)
  @MaxLength(MAX_PAGE_SLUG_LENGTH)
  @Matches(PAGE_SLUG_REGEX, { message: 'errors.website.invalidSlug' })
  readonly slug!: string;
}
