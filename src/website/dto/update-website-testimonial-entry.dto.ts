/** `PATCH academies/:id/website/testimonial-entries/:entryId` request — matches `UpdateWebsiteTestimonialEntryPayload` exactly. No `status` field — see `website-content.schemas.ts`'s doc comment. */
import { IsBoolean, IsInt, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateWebsiteTestimonialEntryDto {
  @IsOptional()
  @IsObject()
  readonly quote?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  readonly authorName?: string;

  @IsOptional()
  @IsObject()
  readonly authorRole?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  readonly avatar?: string;

  @IsOptional()
  @IsInt()
  readonly order?: number;

  @IsOptional()
  @IsBoolean()
  readonly visible?: boolean;
}
