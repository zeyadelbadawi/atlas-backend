/**
 * `/auth/otp/*` request bodies (P64 Communications C4).
 *
 * The code is validated as exactly six digits BEFORE any cryptographic
 * work happens, for the same reason `VerifyTwoFactorDto` does it: this is
 * an endpoint an attacker is expected to hammer, and a malformed
 * submission should cost a 400 rather than an HMAC and a round trip to
 * Postgres. It also means a submission can never spend one of the five
 * attempts by being the wrong SHAPE — only by being the wrong CODE.
 *
 * `challengeId` is length-bounded for the same reason: the reference is
 * an AES-GCM sealed value of known size, so anything far outside that
 * range was never issued by this server and is refused before it reaches
 * the decrypt path.
 */
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SIGN_IN_SURFACES, type SignInSurface } from './sign-in.dto';

/** Both endpoints take the same opaque reference; bounds shared here so they cannot drift apart. */
const CHALLENGE_MIN_LENGTH = 32;
const CHALLENGE_MAX_LENGTH = 512;

export class VerifyEmailOtpDto {
  @IsString()
  @MinLength(CHALLENGE_MIN_LENGTH, { message: 'validation:invalidValue' })
  @MaxLength(CHALLENGE_MAX_LENGTH, { message: 'validation:invalidValue' })
  readonly challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'validation:invalidValue' })
  readonly code!: string;

  /** Asks the backend to trust this browser for its configured window. */
  @IsBoolean()
  readonly rememberDevice!: boolean;

  /**
   * Accepted because the deployed frontend sends them (its
   * `EmailOtpVerifyInput` carries both), and rejecting the request would
   * break a client that is doing nothing wrong. They are NOT used: the
   * surface and academy a session is minted for come from the challenge
   * row the original sign-in wrote — see
   * `AuthService.completeEmailOtpSignIn`.
   */
  @IsOptional()
  @IsIn(SIGN_IN_SURFACES)
  readonly surface?: SignInSurface;

  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'validation:invalidValue' })
  readonly academyId?: string;
}

export class ResendEmailOtpDto {
  @IsString()
  @MinLength(CHALLENGE_MIN_LENGTH, { message: 'validation:invalidValue' })
  @MaxLength(CHALLENGE_MAX_LENGTH, { message: 'validation:invalidValue' })
  readonly challengeId!: string;
}
