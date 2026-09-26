/**
 * `POST /academies/:id/students` request.
 *
 * Unlike Manager/Instructor, "student" is not — and cannot be, see
 * `AcademiesService.createStudent`'s doc comment — an `academy_members`
 * row: `AcademyMemberRole` has no `student` value, and `Enrollment` (the
 * real, only definition of "being a student" in this codebase) requires
 * no academy/organization membership at all. So there is nothing to
 * "grant" an existing user; this always creates a brand-new Atlas account
 * (name + email + password all required, unlike the optional-creation
 * shape of Manager/Instructor) that the owner can hand to a real test
 * student, who then self-discovers and self-enrolls in courses exactly
 * like any other Atlas user would.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateAcademyStudentDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  readonly name!: string;

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
