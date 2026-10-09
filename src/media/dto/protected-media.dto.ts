/**
 * Staff upload bodies for the protected tier (master plan Phase 2 §L).
 */
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * The longest single video Atlas will reserve quota for, in seconds.
 *
 * Twelve hours. Not a product limit on course length — a course can have
 * any number of lessons — but a bound on what ONE reservation may claim,
 * so a typo or a hostile client cannot reserve a tenant's entire yearly
 * allowance (or overflow it into nonsense) with a single request.
 */
const MAX_VIDEO_DURATION_SECONDS = 12 * 60 * 60;

/** W6 — S3/R2's single-PUT maximum; the configured `VIDEO_MAX_UPLOAD_BYTES` may be lower. */
export const MAX_VIDEO_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export class UploadProtectedFileDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  /** `data:` URI or bare base64 — the same bridge the public media upload accepts. */
  @IsString()
  file!: string;

  @IsOptional()
  @IsString()
  courseId?: string;
}

export class CreateVideoUploadDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  /**
   * The ceiling the uploader declares. Atlas reserves this much quota
   * BEFORE issuing the upload URL and asks the provider to refuse
   * anything longer, so the reservation cannot be exceeded by uploading a
   * bigger file than declared.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_DURATION_SECONDS)
  maxDurationSeconds!: number;

  @IsOptional()
  @IsString()
  courseId?: string;

  /**
   * W6 — the exact byte size of the file about to be PUT. Optional for
   * compatibility; when given, the presigned PUT is signed for exactly this
   * `Content-Length` (storage refuses any other size) and the storage quota
   * is charged before the URL is issued. Without it the size is checked,
   * and charged, at completion.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_UPLOAD_BYTES)
  sizeBytes?: number;
}
