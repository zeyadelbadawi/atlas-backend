/**
 * `POST /auth/register` request — matches `RegistrationRequest`
 * (atlas frontend `src/types/identity.types.ts`) field-for-field.
 *
 * Validation floors mirror the frontend's own `registrationSchema`
 * (`src/features/auth/components/RegistrationForm.tsx`): name min length 2,
 * password min length 8. No additional complexity rules are invented —
 * that's not a constraint the frontend enforces today.
 */
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

// `@IsNotEmpty()` matters beyond its literal name here: class-validator's
// other decorators (`@IsString`, `@IsEmail`, `@MinLength`, ...) silently
// skip validation when a property is `undefined` (i.e. the request simply
// omits the key) — only `@IsNotEmpty()`/`@IsDefined()` actually reject a
// missing required field with a 400 instead of letting `undefined` reach
// the service layer. Every required field in every DTO in this module
// carries `@IsNotEmpty()` for exactly this reason.
export class RegisterDto {
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
