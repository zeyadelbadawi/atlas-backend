/** `PATCH blog-posts/:id` request — matches `UpdateBlogPostPayload` exactly. */
import { IsArray, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBlogPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly title?: string;

  /** Phase 6 — see `CreateBlogPostDto`'s identical field for the full rule (future-dated → `scheduled`, validated in `BlogPostsService`). */
  @IsOptional()
  @IsISO8601()
  readonly scheduledAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(70)
  readonly metaTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly metaDescription?: string;

  @IsOptional()
  @IsString()
  readonly ogImage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly excerpt?: string;

  @IsOptional()
  @IsString()
  readonly content?: string;

  @IsOptional()
  @IsString()
  readonly featuredImage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  readonly tags?: readonly string[];
}
