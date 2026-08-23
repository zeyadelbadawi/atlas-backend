/**
 * `POST /auth/password-reset/confirm` — matches `PasswordResetConfirmation`.
 * `newPassword` floor mirrors `ResetPasswordForm`'s own `min(8)`.
 */
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class PasswordResetConfirmDto {
  @IsNotEmpty()
  @IsString()
  readonly token!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  readonly newPassword!: string;
}
