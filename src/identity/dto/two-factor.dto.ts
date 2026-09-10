/**
 * `/auth/2fa/*` request bodies.
 *
 * TOTP codes are validated as exactly six digits before any cryptographic
 * work happens. That is not merely tidiness: it turns malformed input
 * into a cheap 400 instead of a decrypt-plus-HMAC on every junk
 * submission, which matters on an endpoint an attacker is expected to
 * hammer.
 */
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ConfirmTwoFactorDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'validation:invalidValue' })
  token!: string;
}

export class VerifyTwoFactorDto {
  @IsString()
  @MinLength(20, { message: 'validation:invalidValue' })
  @MaxLength(200, { message: 'validation:invalidValue' })
  challengeId!: string;

  /**
   * Exactly one of `token` or `recoveryCode` is required. Modelled with
   * `ValidateIf` so supplying neither fails validation rather than
   * reaching the service and being rejected there as a generic 401 —
   * a malformed request and a wrong code should not look the same to a
   * legitimate client debugging their integration.
   */
  @ValidateIf((dto: VerifyTwoFactorDto) => !dto.recoveryCode)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'validation:invalidValue' })
  token?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'validation:invalidValue' })
  @MaxLength(64, { message: 'validation:invalidValue' })
  recoveryCode?: string;
}

export class DisableTwoFactorDto {
  /** Re-authentication. A session alone must not be able to remove the second factor. */
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  password!: string;
}

export class RegenerateRecoveryCodesDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  password!: string;
}
