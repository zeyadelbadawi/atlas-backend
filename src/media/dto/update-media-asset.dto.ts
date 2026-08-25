/** `PATCH academies/:id/media/:assetId` request — matches `UpdateMediaAssetPayload` exactly: `altText` is the only mutable field the frontend contract defines. */
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMediaAssetDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly altText?: string;
}
