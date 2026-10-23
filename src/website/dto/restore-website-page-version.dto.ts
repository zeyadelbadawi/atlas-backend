/** `POST academies/:id/website/pages/:pageId/versions/:versionId/restore` request (CMS phase 4). */
import { IsInt, IsOptional, Min } from 'class-validator';

export class RestoreWebsitePageVersionDto {
  /**
   * The page `version` the restore is based on — required, like a page
   * save's. Optional here only so a missing token is refused by the service
   * with `errors.website.versionRequired` (see `UpdateWebsitePageDto`).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly expectedVersion?: number;
}
