/**
 * `POST /users/me/delete` request.
 *
 * Deliberately carries NO user id. The account deleted is always the one
 * proved by the access token, so there is no field an attacker could
 * change to delete somebody else's account.
 */
import {
  Equals,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { ACCOUNT_DELETION_REASONS } from '../services/account-deletion.service';

/**
 * What every deletion request states — the self-service one and the
 * Platform Owner's administrative one (`POST
 * /platform-user-management/:id/delete`, which deletes SOMEONE ELSE and so
 * cannot be confirmed by that person's mailbox).
 */
export class DeleteAccountBaseDto {
  /** Must be `true`. Encodes "explicit confirmation" in the contract rather than trusting the UI. */
  @IsBoolean()
  @Equals(true, { message: 'validation:confirmationRequired' })
  confirm!: boolean;

  /** Optional, closed vocabulary. Never required to delete. */
  @IsOptional()
  @IsIn(ACCOUNT_DELETION_REASONS as unknown as string[], {
    message: 'validation:invalidValue',
  })
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'validation:maxLength' })
  feedback?: string;
}

/**
 * Self-service deletion: additionally the emailed code (authentication
 * audit, Decision 1).
 */
export class DeleteAccountDto extends DeleteAccountBaseDto {
  /** The challenge from `POST /users/me/delete/request` (Decision 1). */
  @IsUUID('4', { message: 'validation:invalidValue' })
  challengeId!: string;

  /** The code emailed to the account's verified address. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'validation:invalidValue' })
  code!: string;
}
