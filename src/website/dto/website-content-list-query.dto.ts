/** `GET academies/:id/website/{faq,testimonial}-entries` query contract — the shared `CollectionQuery` base plus `status`, matching the real frontend's `filters: { status }` usage (`FaqSection.tsx`/`SectionConfigForm.tsx` both query `status: 'published'`), flattened to a plain query param by `toCollectionParams`. Exposes every real `WebsiteContentStatus` value defensively, the same way `MediaListQueryDto` exposes every `MediaAssetType`/`MediaAssetStatus` value. */
import { IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { WEBSITE_CONTENT_STATUS_VALUES } from '../constants/website.constants';

export class WebsiteContentListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(WEBSITE_CONTENT_STATUS_VALUES)
  readonly status?: (typeof WEBSITE_CONTENT_STATUS_VALUES)[number];
}
