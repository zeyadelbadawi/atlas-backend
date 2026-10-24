import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ConsentsDto } from '../consents/consents.dto';
import { PHONE_INPUT_MAX_LENGTH } from '../phone/phone-number.policy';

/** `POST /auth/apple/native` — what `ASAuthorizationAppleIDCredential` gave the app. */
export class AppleNativeSignInDto {
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  readonly identityToken!: string;

  /** The random nonce the app generated; Apple signed its SHA-256. */
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._~-]+$/)
  readonly rawNonce!: string;

  /** One-time code, exchanged for the refresh token used to revoke on deletion. */
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  readonly authorizationCode?: string;

  /** Apple shares the name only on the first authorization. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly givenName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly familyName?: string;

  @IsString()
  @MaxLength(64)
  readonly academyId!: string;
}

export class AppleLinkDto {
  @IsString()
  @MaxLength(128)
  readonly pending!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  readonly password!: string;
}

export class AppleCreateAccountDto {
  @IsString()
  @MaxLength(128)
  readonly pending!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  readonly name!: string;

  @IsString()
  @MaxLength(PHONE_INPUT_MAX_LENGTH)
  readonly phoneNumber!: string;

  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  readonly phoneCountry!: string;

  @ValidateNested()
  @Type(() => ConsentsDto)
  readonly consents!: ConsentsDto;
}
