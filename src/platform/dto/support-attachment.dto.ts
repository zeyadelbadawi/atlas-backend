/**
 * The optional image a requester may attach to a ticket message (P53).
 *
 * SHAPE IS DELIBERATELY `UploadMediaAssetDto`'S, MINUS `altText`. Atlas has
 * exactly one client→server file transport — the base64 data-URL bridge
 * (`UploadMediaAssetPayload`, `useMediaUpload`'s `FileReader` path) — and a
 * support attachment uses it unchanged rather than introducing multipart
 * for one feature. `altText` is omitted because a ticket screenshot is
 * described by the message body it accompanies; there is no field for the
 * user to fill, so offering one would be a control that means nothing.
 *
 * NOTHING HERE IS TRUSTED AS FACT. `mimeType` and `sizeBytes` are validated
 * for shape only. The real kind comes from `detectFileKind`'s magic-byte
 * sniff of the decoded buffer and the real size from that buffer's length —
 * exactly as `MediaService.parseAndValidate` already does, using the same
 * functions. `fileName` is display-only and is sanitized before storage; it
 * never addresses an object.
 */
import { IsInt, IsNotEmpty, IsPositive, IsString, MaxLength } from 'class-validator';

export class SupportAttachmentInputDto {
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
}
