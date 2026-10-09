/**
 * `POST /academies/:id/members` request.
 *
 * There is no invitation system anywhere in this codebase (no
 * `Invitation` model, no token, no email template — confirmed by
 * grepping both trees) — the only user-creating endpoint is
 * unauthenticated self-registration (`POST /auth/register`). Rather than
 * build a full email-invitation flow, this DTO supports both real cases
 * an owner has: granting Manager access to a user who ALREADY has an
 * Atlas account (`email` alone), or creating a brand-new account for
 * someone who doesn't yet (`email` + `name` + `password` together) and
 * granting them Manager access in the same action. See
 * `AcademiesService.addManager`'s doc comment for the full flow this
 * request drives.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddAcademyManagerDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  /**
   * Always required (ATO review F5): it is used only if the address has no
   * account yet — an existing account keeps its own name — but asking for
   * it every time means the request can never reveal which case applies.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  readonly name!: string;

  /**
   * Launch Stabilization A2 (D2) — DEPRECATED and ignored. A brand-new
   * account is created `invited` (from `email` + `name`) and its owner sets
   * their own password through the emailed setup link.
   */
  @IsOptional()
  @IsString()
  readonly password?: string;
}
