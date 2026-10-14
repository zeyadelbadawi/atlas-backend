import { Equals, IsBoolean } from 'class-validator';

/**
 * `POST /platform-privacy-requests/:id/fulfil`. Must be `true`: for a
 * deletion request this deletes the account, so the contract encodes the
 * explicit confirmation rather than trusting the UI.
 */
export class FulfilPrivacyRequestDto {
  @IsBoolean()
  @Equals(true, { message: 'validation:confirmationRequired' })
  confirm!: boolean;
}
