/**
 * `POST /auth/academy-join` request — an existing Atlas account joins the
 * academy whose website it is on (`AuthService.joinAcademy`). Never creates
 * an account, so there is no `name` here.
 */
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class AcademyJoinDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(1024)
  readonly password!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  readonly academyId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  readonly inviteToken?: string;
}
