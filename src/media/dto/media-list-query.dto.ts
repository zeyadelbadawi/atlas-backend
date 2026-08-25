/** `GET academies/:id/media` query contract — the shared `CollectionQuery` base (`search` is the only filter the real frontend `MediaLibraryDialog` currently sends) plus `status`/`type`, exposed defensively the same way `CourseListQueryDto` exposes every real enum value as an optional filter. */
import { IsIn, IsOptional } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { MEDIA_ASSET_STATUS_VALUES, MEDIA_ASSET_TYPE_VALUES } from './media.constants';

export class MediaListQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsIn(MEDIA_ASSET_STATUS_VALUES)
  readonly status?: (typeof MEDIA_ASSET_STATUS_VALUES)[number];

  @IsOptional()
  @IsIn(MEDIA_ASSET_TYPE_VALUES)
  readonly type?: (typeof MEDIA_ASSET_TYPE_VALUES)[number];
}
