/** `POST /auth/verify-email` request. The token arrives from the emailed link; it is hashed before any lookup, never used raw. */
import { IsString, MinLength } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @MinLength(16, { message: 'validation:minLength' })
  token!: string;
}
