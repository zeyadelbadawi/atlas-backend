/** `POST academies/:id/website/testimonial-entries` request — matches `CreateWebsiteTestimonialEntryPayload` exactly. See `create-website-faq-entry.dto.ts`'s doc comment for why deep validation happens in the service, not here. */
import { IsObject, IsOptional, IsString } from 'class-validator';

export class CreateWebsiteTestimonialEntryDto {
  @IsObject()
  readonly quote!: Record<string, unknown>;

  @IsString()
  readonly authorName!: string;

  @IsOptional()
  @IsObject()
  readonly authorRole?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  readonly avatar?: string;
}
