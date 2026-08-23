/**
 * `PATCH /users/me` — matches `CurrentUserService.updateProfile`'s
 * `Partial<Pick<CurrentUser, 'name' | 'avatar'>>` exactly. Master plan §21
 * P1 / "Profile update": deliberately just these two fields — no email
 * change, phone, or bio, because the frontend form has no such fields.
 */
import { IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  readonly name?: string;

  // Plain string, not `@IsUrl` — P1 has no Media Library (that's Phase P8),
  // so nothing in this phase's contract defines what an avatar value looks
  // like beyond "a string the frontend stores and renders as `<img src>`."
  // Enforcing a stricter shape here would be inventing a constraint no
  // current spec requires.
  @IsOptional()
  @IsString()
  @MinLength(1)
  readonly avatar?: string;
}
