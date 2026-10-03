/**
 * `PATCH .../order` request — matches `ReorderItemsPayload` (`course.types.ts`):
 * the full, new ordering as an explicit list of ids. The client (move
 * up/down buttons or drag-and-drop) computes the new full array; the
 * backend validates it is exactly the current set and persists it — no
 * partial/delta reorder model.
 *
 * `expectedOrderedIds` (optional) is the order the client was looking at
 * when it built `orderedIds`. When present and it no longer matches the
 * stored order, the write is refused with 409 `stale_resource_version`
 * instead of silently overwriting a concurrent reorder.
 */
import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
} from 'class-validator';

export class ReorderItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  readonly orderedIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  readonly expectedOrderedIds?: string[];
}
