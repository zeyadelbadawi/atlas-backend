/**
 * `POST /auth/verify-email` request. The token arrives from the emailed
 * link; it is hashed before any lookup, never used raw.
 *
 * Only the TYPE and a generous size bound are checked here. The token's
 * format is checked by `AuthService.verifyEmail`, which answers a
 * malformed token with exactly the error an unknown one gets — a
 * distinct validation error would tell a prober which half of the check
 * its input failed.
 */
import { IsString, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  @IsString()
  @MaxLength(2048)
  token!: string;
}
