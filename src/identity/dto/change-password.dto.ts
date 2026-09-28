/**
 * `POST /users/me/password` — matches `CurrentUserService.changePassword`'s
 * `{ currentPassword, newPassword }` exactly.
 */
import { IsNotEmpty, IsString, MinLength, MaxLength } from 'class-validator';

export class ChangePasswordDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(1024)
  readonly currentPassword!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  readonly newPassword!: string;
}
