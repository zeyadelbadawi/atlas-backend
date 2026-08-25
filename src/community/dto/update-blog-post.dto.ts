/** `PATCH blog-posts/:id` request — matches `UpdateBlogPostPayload` exactly. */
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateBlogPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly title?: string;

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
