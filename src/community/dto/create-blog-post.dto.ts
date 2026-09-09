/**
 * `POST blog-posts` request — matches `CreateBlogPostPayload`
 * (`blog.types.ts`) field-for-field, plus one Phase 1 (Extended Scope,
 * Decision 11, dependency B) addition: an OPTIONAL `academyId`. Omitted,
 * behavior is unchanged from before this phase (resolved from the
 * author's own session, narrowly, per `BlogPostsService.
 * resolveAuthorAcademyId`'s pre-existing rule). Supplied — the one real
 * gap this phase closes — a staff member who belongs to MORE THAN ONE
 * Academy can now specify exactly which one they are authoring for,
 * instead of always hitting the "ambiguous academy" hard failure; the
 * value is still fully validated against the caller's own real
 * memberships, never trusted on its own.
 * `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment
 * (identity module): the other decorators silently skip `undefined`.
 */
import {
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateBlogPostDto {
  @IsOptional()
  @IsString()
  readonly academyId?: string;

  /** Phase 6 — future-dated publish. Omitted/absent stays `draft`; a valid future timestamp puts the post in `scheduled` status, published by the same Phase 2 sweep tick that already publishes scheduled announcements. Past-dated values are rejected by `BlogPostsService` (see its own doc comment), not here — mirrors `CreateAnnouncementDto`'s identical field exactly. */
  @IsOptional()
  @IsISO8601()
  readonly scheduledAt?: string;

  /** Phase 6 — SEO metadata, real persisted data (never derived/faked at render time). */
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
