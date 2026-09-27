/**
 * `POST /auth/academy-join` request — an existing Atlas account joins the
 * academy whose website it is on (`AuthService.joinAcademy`). Never creates
 * an account, so there is no `name` here.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AcademyJoinDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  readonly password!: string;

  @IsNotEmpty()
  @IsString()
  readonly academyId!: string;

  @IsOptional()
  @IsString()
  readonly inviteToken?: string;
}
