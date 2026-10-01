/**
 * `POST public/websites/:academyId/contact` request — the real backend
 * destination for the public Contact section's form. No `academyId` field
 * here: the target academy comes from the trusted route param, resolved
 * server-side to an organization by `PublicWebsiteService` exactly like
 * every other method on that service — never a body field, which would
 * reopen the "client-supplied tenant id" hole this phase closes.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitContactMessageDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(200)
  readonly name!: string;

  @IsNotEmpty()
  @IsEmail()
  @MaxLength(320)
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(5000)
  readonly message!: string;

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
