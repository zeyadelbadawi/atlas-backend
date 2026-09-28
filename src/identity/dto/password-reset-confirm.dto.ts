/**
 * `POST /auth/password-reset/confirm` — matches `PasswordResetConfirmation`.
 * `newPassword` floor mirrors `ResetPasswordForm`'s own `min(8)`.
 */
import { IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  readonly token!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  readonly newPassword!: string;
}
