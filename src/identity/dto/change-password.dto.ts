/**
 * `POST /users/me/password` — matches `CurrentUserService.changePassword`'s
 * `{ currentPassword, newPassword }` exactly.
 */
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsNotEmpty()
  @IsString()
  readonly currentPassword!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  readonly newPassword!: string;
}
