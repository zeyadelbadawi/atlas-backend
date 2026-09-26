import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/** `POST academies/:id/media/archive-batch` — bulk delete (archive) of up to 50 assets. */
export class ArchiveMediaBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  readonly assetIds!: string[];
}
