/**
 * `POST organizations/:id/support-cases` / `POST academies/:id/support-cases`
 * request (Phase 8) — the tenant-facing create path `support_cases` never
 * had before this phase (see the P15 migration's own doc comment: "no
 * create-case endpoint in this phase"). `description` becomes the case's
 * first message (`authorRole: 'requester'`), mirroring how a Platform
 * Owner's reply is itself just a `SupportCaseMessage` row — a ticket IS a
 * subject plus a message thread, never a separate free-text field on the
 * case itself.
 *
 * Deliberately no `priority`/`academyId` field here: `academyId` is
 * resolved from the ROUTE (`academies/:id/...` vs `organizations/:id/...`),
 * never client-supplied on the body, and `priority` always starts at the
 * schema default (`medium`) — only a Platform Owner triages priority
 * (`PATCH .../status` is the only tenant-invisible lever that exists;
 * there is no `PATCH priority` endpoint at all), matching "never invent
 * business behavior the frontend contract doesn't call for."
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  MAX_SUPPORT_DESCRIPTION_LENGTH,
  MAX_SUPPORT_SUBJECT_LENGTH,
} from './support.constants';

export class CreateSupportCaseDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SUPPORT_SUBJECT_LENGTH)
  readonly subject!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SUPPORT_DESCRIPTION_LENGTH)
  readonly description!: string;
}
