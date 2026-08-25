/** `POST courses/:courseId/announcements` request — matches `CreateAnnouncementPayload` (`announcement.types.ts`) exactly. Scope (`audience: 'course'`, `courseId`, `academyId`) is fixed by the route, never a body field — matches the frontend payload's own shape (no scope field at all). `@IsNotEmpty()` for required fields — see `RegisterDto`'s comment (identity module): the other decorators silently skip `undefined`. */
import { IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAnnouncementDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly title!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(10000)
  readonly body!: string;

  @IsOptional()
  @IsISO8601()
  readonly scheduledAt?: string;
}
