/**
 * `POST academies/:id/website/faq-entries` request — matches
 * `CreateWebsiteFaqEntryPayload` (`website-content.types.ts`) exactly.
 * Only the top-level shape is declared here (satisfying the global
 * `ValidationPipe`'s `whitelist`/`forbidNonWhitelisted` requirement) — the
 * real, security-critical localized-field validation happens against
 * `createFaqEntrySchema` inside `WebsiteContentService`, matching the
 * established pattern in `update-website-page.dto.ts`.
 */
import { IsObject } from 'class-validator';

export class CreateWebsiteFaqEntryDto {
  @IsObject()
  readonly question!: Record<string, unknown>;

  @IsObject()
  readonly answer!: Record<string, unknown>;
}
