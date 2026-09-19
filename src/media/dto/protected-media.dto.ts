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
}
