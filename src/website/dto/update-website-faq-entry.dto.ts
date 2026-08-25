/** `PATCH academies/:id/website/faq-entries/:entryId` request — matches `UpdateWebsiteFaqEntryPayload` exactly. No `status` field — see `website-content.schemas.ts`'s doc comment. */
import { IsBoolean, IsInt, IsObject, IsOptional } from 'class-validator';

export class UpdateWebsiteFaqEntryDto {
  @IsOptional()
  @IsObject()
  readonly question?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  readonly answer?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  readonly order?: number;

  @IsOptional()
  @IsBoolean()
  readonly visible?: boolean;
}
