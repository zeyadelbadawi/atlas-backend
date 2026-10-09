/**
 * `PUT /users/me/phone` — sets or replaces the caller's own phone number.
 * The number as typed plus the chosen ISO 3166-1 alpha-2 country; the server
 * normalises and validates (`phone-number.policy.ts`). No user id anywhere:
 * the subject is the account proved by the access token.
 */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import {
  IsMobilePhoneNumber,
  IsPhoneCountry,
  IsPhoneNumberFor,
  IsPhoneNumberInCountry,
} from '../phone/phone-number.validators';
import { PHONE_INPUT_MAX_LENGTH } from '../phone/phone-number.policy';

export class UpdatePhoneDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(PHONE_INPUT_MAX_LENGTH)
  @IsPhoneNumberFor('phoneCountry')
  @IsPhoneNumberInCountry('phoneCountry')
  @IsMobilePhoneNumber('phoneCountry')
  readonly phoneNumber!: string;

  @IsNotEmpty()
  @IsString()
  @IsPhoneCountry()
  readonly phoneCountry!: string;
}
