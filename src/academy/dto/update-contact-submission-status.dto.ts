/** `PATCH academies/:id/contact-submissions/:submissionId` request — staff triage (read/archive), never re-opens the public write path. */
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

const ALLOWED_STATUSES = ['read', 'archived'] as const;

export class UpdateContactSubmissionStatusDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(ALLOWED_STATUSES)
  readonly status!: (typeof ALLOWED_STATUSES)[number];
}
