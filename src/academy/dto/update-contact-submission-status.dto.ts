/** `PATCH academies/:id/contact-submissions/:submissionId` request — staff triage (read/archive), never re-opens the public write path. */
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

// `new` marks a message unread again; `read` also restores an archived one.
const ALLOWED_STATUSES = ['new', 'read', 'archived'] as const;

export class UpdateContactSubmissionStatusDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(ALLOWED_STATUSES)
  readonly status!: (typeof ALLOWED_STATUSES)[number];
}
