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
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class AddAcademyManagerDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  /** Required only when creating a brand-new account (no existing user for `email`). */
  @IsOptional()
  @IsString()
  @MinLength(2)
  readonly name?: string;

  /** Required only when creating a brand-new account (no existing user for `email`). */
  @IsOptional()
  @IsString()
  @MinLength(8)
  readonly password?: string;
}
