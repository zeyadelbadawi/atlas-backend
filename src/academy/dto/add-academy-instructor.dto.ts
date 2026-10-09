/**
 * `POST /academies/:id/instructors` request — the Instructor counterpart
 * of `AddAcademyManagerDto`. Same shape, same rationale: grant an
 * already-registered user Instructor access via `email` alone, or create
 * a brand-new account and grant it in one action via `email` + `name` +
 * `password`. See `AcademiesService.addInstructor`'s doc comment.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddAcademyInstructorDto {
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
