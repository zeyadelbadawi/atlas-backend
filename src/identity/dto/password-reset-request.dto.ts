/** `POST /auth/password-reset/request` — matches `PasswordResetRequest`. */
import { IsEmail, IsNotEmpty } from 'class-validator';

export class PasswordResetRequestDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;
}
