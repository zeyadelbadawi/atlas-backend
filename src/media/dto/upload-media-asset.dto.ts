/**
 * `POST academies/:id/media` request — matches `UploadMediaAssetPayload`
 * (`media.types.ts`) exactly: the base64-bridge V1 contract, no other
 * shape exists anywhere in the frontend. `mimeType`/`sizeBytes` are
 * validated here only for presence/shape — never trusted as the real
 * file kind/size (`MediaService`/`file-validation.util.ts` derive both
 * from the actual decoded bytes; see that module's own doc comment).
 * `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment
 * (identity module): the other decorators silently skip `undefined`.
 */
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class UploadMediaAssetDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly fileName!: string;

  @IsNotEmpty()
  @IsString()
  readonly mimeType!: string;

  @IsInt()
  @IsPositive()
  readonly sizeBytes!: number;

  @IsNotEmpty()
  @IsString()
  readonly dataUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly altText?: string;
}
