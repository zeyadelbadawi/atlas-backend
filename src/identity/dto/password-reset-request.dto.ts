/** `POST /auth/password-reset/request` — matches `PasswordResetRequest`. */
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';

export class PasswordResetRequestDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  readonly email!: string;
}
