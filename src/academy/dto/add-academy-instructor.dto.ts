/**
 * `POST /academies/:id/instructors` request — the Instructor counterpart
 * of `AddAcademyManagerDto`. Same shape, same rationale: grant an
 * already-registered user Instructor access via `email` alone, or create
 * a brand-new account and grant it in one action via `email` + `name` +
 * `password`. See `AcademiesService.addInstructor`'s doc comment.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class AddAcademyInstructorDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  readonly name?: string;

  /**
   * Launch Stabilization A2 (D2) — DEPRECATED and ignored. A brand-new
   * account is created `invited` (from `email` + `name`) and its owner sets
   * their own password through the emailed setup link.
   */
  @IsOptional()
  @IsString()
  readonly password?: string;
}
