/**
 * `POST /auth/refresh` request.
 *
 * Browsers send NO body: the refresh token is the HttpOnly session cookie
 * (production-readiness pass). A body token is accepted only so a browser
 * still holding a pre-cookie token from `localStorage` can convert it into a
 * cookie session once; new refresh tokens are never returned in a body, so
 * this path serves only tokens issued before the change.
 */
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  readonly refreshToken?: string;
}
