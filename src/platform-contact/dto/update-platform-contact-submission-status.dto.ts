/** `PATCH platform/contact-submissions/:id` — move one enquiry between new/read/archived. */
import { IsIn } from 'class-validator';
import type { PlatformContactSubmissionStatus } from '@prisma/client';
import { PLATFORM_CONTACT_STATUSES } from '../platform-contact.constants';

export class UpdatePlatformContactSubmissionStatusDto {
  @IsIn(PLATFORM_CONTACT_STATUSES)
  readonly status!: PlatformContactSubmissionStatus;
}
