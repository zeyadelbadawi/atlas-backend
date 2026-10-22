/**
 * `POST public/websites/:academyId/contact` request — the real backend
 * destination for the public Contact section's form, and (CMS phase 3d,
 * batch C) for the "register your interest" section (`kind: 'interest'`).
 * No `academyId` field here: the target academy comes from the trusted
 * route param, resolved server-side to an organization by
 * `PublicWebsiteService` exactly like every other method on that service —
 * never a body field, which would reopen the "client-supplied tenant id"
 * hole this phase closes.
 *
 * ONE ENDPOINT, TWO FORMS. Both share this route's throttle (5 per 10
 * minutes per client), its honeypot (`company`), its table and its inbox.
 * - `contact` (the default, what every existing caller sends): name, email
 *   and message, all required — exactly as before.
 * - `interest`: name and phone are required; email and message are checked
 *   only when sent (send nothing for an empty field); `sectionId` names the
 *   published `interestForm` section the visitor used, and `choice` the id
 *   of the option they picked. What the section asks for (which fields are
 *   required, which options exist) is checked by the service against the
 *   PUBLISHED section, never trusted from the client.
 */
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  IsMobilePhoneNumber,
  IsPhoneCountry,
  IsPhoneNumberFor,
  IsPhoneNumberInCountry,
  hasPhoneInput,
} from '../../identity/phone/phone-number.validators';
import { PHONE_INPUT_MAX_LENGTH } from '../../identity/phone/phone-number.policy';

export const CONTACT_SUBMISSION_KINDS = ['contact', 'interest'] as const;
export type ContactSubmissionKindValue = (typeof CONTACT_SUBMISSION_KINDS)[number];

/** The longest id a section or an option carries (they are UUIDs). */
const MAX_REFERENCE_LENGTH = 100;

const isInterest = (dto: SubmitContactMessageDto): boolean => dto.kind === 'interest';

export class SubmitContactMessageDto {
  /** Which form sent this; absent means the Contact form. */
  @IsOptional()
  @IsIn(CONTACT_SUBMISSION_KINDS)
  readonly kind?: ContactSubmissionKindValue;

  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly name!: string;

  /** Required by the Contact form; an interest form sends it only when filled. */
  @ValidateIf(
    (dto: SubmitContactMessageDto) => !isInterest(dto) || dto.email !== undefined,
  )
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(320)
  readonly email?: string;

  /** Required by the Contact form; an interest form sends it only when filled. */
  @ValidateIf(
    (dto: SubmitContactMessageDto) => !isInterest(dto) || dto.message !== undefined,
  )
  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  readonly message?: string;

  /**
   * An interest submission's phone as typed plus its ISO country; both
   * required there, server-normalised to E.164 (the same rules as every
   * other phone in Atlas). Not stored for a contact message.
   */
  @ValidateIf((dto: SubmitContactMessageDto) => isInterest(dto) || hasPhoneInput(dto))
  @IsNotEmpty()
  @IsString()
  @MaxLength(PHONE_INPUT_MAX_LENGTH)
  @IsPhoneNumberFor('phoneCountry')
  @IsPhoneNumberInCountry('phoneCountry')
  @IsMobilePhoneNumber('phoneCountry')
  readonly phoneNumber?: string;

  @ValidateIf((dto: SubmitContactMessageDto) => isInterest(dto) || hasPhoneInput(dto))
  @IsNotEmpty()
  @IsString()
  @IsPhoneCountry()
  readonly phoneCountry?: string;

  /** The published `interestForm` section the visitor used. */
  @ValidateIf(isInterest)
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_REFERENCE_LENGTH)
  readonly sectionId?: string;

  /** The id of the option the visitor chose (checked against the section's options). */
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_REFERENCE_LENGTH)
  readonly choice?: string;

  /** The language the visitor read the form in — which option label is kept. */
  @IsOptional()
  @IsIn(['en', 'ar'])
  readonly locale?: 'en' | 'ar';

  /**
   * Honeypot — the public form renders this field hidden from people, so
   * only an automated filler sends a value. A non-empty value makes
   * `PublicWebsiteService.submitContactMessage` discard the submission
   * while answering exactly as if it were stored.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly company?: string;
}
