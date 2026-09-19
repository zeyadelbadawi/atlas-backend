/**
 * `POST /auth/sign-in` request — matches `SignInCredentials` field-for-field.
 *
 * `rememberMe` is accepted and validated (so the request doesn't fail
 * `forbidNonWhitelisted` validation) but is not wired to any behavior
 * change — the frontend type declares it, but neither the master plan nor
 * any frontend service consumes it for anything (no "extended session"
 * concept exists anywhere in the contract). Inventing a meaning for it here
 * would be exactly the kind of undocumented product decision this phase
 * must not make; see the final report's "deliberately deferred" list.
 */
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export const SIGN_IN_SURFACES = ['management', 'academy'] as const;
export type SignInSurface = (typeof SIGN_IN_SURFACES)[number];

export class SignInDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  readonly password!: string;

  @IsOptional()
  @IsBoolean()
  readonly rememberMe?: boolean;

  /**
   * P64 Phase 1 (AD-5) — which surface the caller is signing in on. The
   * management dashboard refuses learners; an academy website requires
   * `academyId` (verified against the request host). Defaults to
   * `management` for older clients.
   */
  @IsOptional()
  @IsIn(SIGN_IN_SURFACES)
  readonly surface?: SignInSurface;

  @IsOptional()
  @IsString()
  readonly academyId?: string;
}
