/**
 * `POST blog-posts` request — matches `CreateBlogPostPayload`
 * (`blog.types.ts`) exactly. No `academyId` field — the owning academy (or
 * platform-level, for a platform owner) is resolved server-side from the
 * author's own session; see `BlogPostsService`'s `resolveAuthorAcademyId`
 * doc comment for the exact, narrow rule this DTO does not itself encode.
 * `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment
 * (identity module): the other decorators silently skip `undefined`.
 */
import { IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBlogPostDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly title!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly slug!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly excerpt?: string;

  @IsNotEmpty()
  @IsString()
  readonly content!: string;

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
