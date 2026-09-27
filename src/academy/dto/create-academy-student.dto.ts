/**
 * `POST /academies/:id/students` request.
 *
 * Unlike Manager/Instructor, "student" is not — and cannot be, see
 * `AcademiesService.createStudent`'s doc comment — an `academy_members`
 * row: the learner relationship is an `academy_students` row. An email
 * that already has an Atlas account is added to this academy as-is; a new
 * email becomes an invited account, which is the only case that needs
 * `name` (the service answers 400 `nameRequiredForNewAccount` without it).
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAcademyStudentDto {
  /** Required only when creating a brand-new account (no existing user for `email`). */
  @IsOptional()
  @IsString()
  @MinLength(2)
  readonly name?: string;

  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  /**
   * Launch Stabilization A2 (D2) — DEPRECATED and ignored. The new account
   * is `invited` and its owner sets their own password through the emailed
   * setup link; a password chosen by staff is never stored. Still accepted
   * so older clients do not fail validation.
   */
  @IsOptional()
  @IsString()
  readonly password?: string;
}
