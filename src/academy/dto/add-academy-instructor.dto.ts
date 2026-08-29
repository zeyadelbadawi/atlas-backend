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

  @IsOptional()
  @IsString()
  @MinLength(8)
  readonly password?: string;
}
