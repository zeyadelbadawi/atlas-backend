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
  MaxLength,
} from 'class-validator';
import { ACCOUNT_DELETION_REASONS } from '../services/account-deletion.service';

export class DeleteAccountDto {
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
