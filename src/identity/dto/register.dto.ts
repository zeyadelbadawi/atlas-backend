/**
 * `POST /auth/register` request — matches `RegistrationRequest`
 * (atlas frontend `src/types/identity.types.ts`) field-for-field.
 *
 * Validation floors mirror the frontend's own `registrationSchema`
 * (`src/features/auth/components/RegistrationForm.tsx`): name min length 2,
 * password min length 8. No additional complexity rules are invented —
 * that's not a constraint the frontend enforces today.
 *
 * `academyId` (Phase 1, Extended Scope, Decision 11, dependency D) is
 * optional and additive: absent, registration behaves exactly as before
 * (the self-service Organization-Owner onboarding journey, Decision 5).
 * Supplied — by the public Academy website's Sign Up page (dependency C),
 * which already knows its own resolved Academy id — it must resolve to a
 * real Academy or the whole registration is rejected; see
 * `AuthService.resolveRegistrationAcademyId`.
 */
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

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
  @MaxLength(100)
  readonly name!: string;

  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  readonly email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(1024)
  readonly password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly academyId?: string;

  /** P64 Phase 1 (D3) — required when the academy's registration policy is `invite`. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  readonly inviteToken?: string;

  /**
   * New Customer Onboarding (docs/NEW_CUSTOMER_ONBOARDING.md §3.2) — the
   * Organization the new owner creates in the same request. Refused unless
   * `FLAG_SIGNUP_ORGANIZATION_MODE=on` and the request is on the management
   * surface. A label only; it authorizes nothing.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  readonly organizationName?: string;

  /**
   * The Free Trial plan chosen on the signup page. Only a lookup key: the
   * server re-reads the live catalog (active, customer-facing,
   * trial-eligible) and the trial policy, and refuses anything else.
   */
  @IsOptional()
  @IsUUID()
  readonly planId?: string;
}
