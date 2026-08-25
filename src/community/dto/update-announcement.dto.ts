/** `PATCH courses/:courseId/announcements/:id` request — matches `UpdateAnnouncementPayload` exactly. */
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  readonly title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  readonly body?: string;

  @IsOptional()
  @IsISO8601()
  readonly scheduledAt?: string;
}
