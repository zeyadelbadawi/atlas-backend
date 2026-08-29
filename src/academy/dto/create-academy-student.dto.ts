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
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class CreateAcademyStudentDto {
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  readonly name!: string;

  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  readonly password!: string;
}
