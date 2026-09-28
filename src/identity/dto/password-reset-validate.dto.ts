import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** P64 Phase 1 — `POST /auth/password-reset/validate`. */
export class PasswordResetValidateDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  readonly token!: string;
}
