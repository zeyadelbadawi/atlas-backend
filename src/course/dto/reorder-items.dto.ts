/** `PATCH .../order` request — matches `ReorderItemsPayload` (`course.types.ts`) exactly: the full, new ordering as an explicit list of ids. Mirrors the frontend's actual move-up/move-down semantics (`moveItem` computes the new full array client-side; the backend just persists it) — no drag-and-drop backend assumption, no partial/delta reorder model. */
import { ArrayNotEmpty, ArrayUnique, IsArray, IsString } from 'class-validator';

export class ReorderItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  readonly orderedIds!: string[];
}
