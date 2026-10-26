/**
 * B3 — marketing blog request DTOs (class-validator).
 *
 * Drafts may hold a half-written language: the per-language fields carry
 * only their MAXIMUM lengths here. The minimums (title 3, excerpt 20, a
 * body, alt text with a cover) are the parity rule, checked when a post
 * goes public or a public post is edited (`incompleteLocales`) → 422
 * `errors.blog.translationsIncomplete`.
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { IsHttpsOrSiteRelativeUrl } from '../../common/validation/safe-url.util';
import {
  BLOG_KINDS,
  BLOG_LIMITS,
  BLOG_LOCALES,
  BLOG_SLUG_MAX,
  BLOG_SLUG_MIN,
  BLOG_SLUG_PATTERN,
  BLOG_STATUSES,
  BLOG_TOPICS,
  type BlogLocale,
} from '../blog-rules';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const BLOG_SORT_FIELDS = ['updatedAt', 'publishAt', 'title'] as const;
export type BlogSortField = (typeof BLOG_SORT_FIELDS)[number];

export const PUBLIC_BLOG_DEFAULT_PAGE_SIZE = 12;
export const PUBLIC_BLOG_MAX_PAGE_SIZE = 24;

export class ListBlogPostsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(BLOG_STATUSES)
  readonly status?: (typeof BLOG_STATUSES)[number];

  @IsOptional()
  @IsIn(BLOG_TOPICS)
  readonly topic?: (typeof BLOG_TOPICS)[number];

  @IsOptional()
  @IsIn(BLOG_KINDS)
  readonly kind?: (typeof BLOG_KINDS)[number];

  @IsOptional()
  @IsIn(BLOG_SORT_FIELDS)
  declare readonly sortBy?: BlogSortField;

  /** Alias of `sortBy` (the contract's spelling). */
  @IsOptional()
  @IsIn(BLOG_SORT_FIELDS)
  readonly sort?: BlogSortField;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  declare readonly search?: string;
}

export class BlogCoverImageDto {
  @IsString()
  @MaxLength(2000)
  @IsHttpsOrSiteRelativeUrl()
  readonly url!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20_000)
  readonly width!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20_000)
  readonly height!: number;
}

export class BlogTranslationDto {
  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.title.max)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.excerpt.max)
  readonly excerpt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.body.max)
  readonly body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.coverAlt.max)
  readonly coverAlt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.seoTitle.max)
  readonly seoTitle?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(BLOG_LIMITS.seoDescription.max)
  readonly seoDescription?: string | null;
}

/** Each language given replaces that language wholesale; `null` clears it; absent keeps it. */
export class BlogTranslationsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => BlogTranslationDto)
  readonly en?: BlogTranslationDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => BlogTranslationDto)
  readonly ar?: BlogTranslationDto | null;
}

class BlogPostFieldsDto {
  @IsOptional()
  @IsBoolean()
  readonly featured?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => BlogCoverImageDto)
  readonly coverImage?: BlogCoverImageDto | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(BLOG_LIMITS.authorName.min)
  @MaxLength(BLOG_LIMITS.authorName.max)
  readonly authorName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(BLOG_LIMITS.relatedPosts.max)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  readonly relatedPostIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => BlogTranslationsDto)
  readonly translations?: BlogTranslationsDto;
}

export class CreateBlogPostDto extends BlogPostFieldsDto {
  @Transform(trim)
  @IsString()
  @MinLength(BLOG_SLUG_MIN)
  @MaxLength(BLOG_SLUG_MAX)
  @Matches(BLOG_SLUG_PATTERN)
  readonly slug!: string;

  @IsIn(BLOG_KINDS)
  readonly kind!: (typeof BLOG_KINDS)[number];

  @IsIn(BLOG_TOPICS)
  readonly topic!: (typeof BLOG_TOPICS)[number];
}

export class UpdateBlogPostDto extends BlogPostFieldsDto {
  /** Optimistic concurrency: the `version` the editor last read. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(BLOG_SLUG_MIN)
  @MaxLength(BLOG_SLUG_MAX)
  @Matches(BLOG_SLUG_PATTERN)
  readonly slug?: string;

  @IsOptional()
  @IsIn(BLOG_KINDS)
  readonly kind?: (typeof BLOG_KINDS)[number];

  @IsOptional()
  @IsIn(BLOG_TOPICS)
  readonly topic?: (typeof BLOG_TOPICS)[number];
}

export class BlogVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  readonly version!: number;
}

export class PublishBlogPostDto extends BlogVersionDto {
  /** Absent or not in the future: published now. In the future: scheduled. */
  @IsOptional()
  @IsISO8601({ strict: true })
  readonly publishAt?: string;
}

export class BlogLocaleQueryDto {
  @IsOptional()
  @IsIn(BLOG_LOCALES)
  readonly locale?: BlogLocale;
}

export class PublicBlogListQueryDto extends BlogLocaleQueryDto {
  @IsOptional()
  @IsIn(BLOG_TOPICS)
  readonly topic?: (typeof BLOG_TOPICS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUBLIC_BLOG_MAX_PAGE_SIZE)
  readonly pageSize?: number;
}
