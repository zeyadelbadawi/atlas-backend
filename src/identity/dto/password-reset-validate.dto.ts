import { IsNotEmpty, IsString } from 'class-validator';

/** P64 Phase 1 — `POST /auth/password-reset/validate`. */
export class PasswordResetValidateDto {
  @IsNotEmpty()
  @IsString()
  readonly token!: string;
}
