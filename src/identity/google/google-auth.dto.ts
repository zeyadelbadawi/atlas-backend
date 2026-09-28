import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** `POST /auth/google/authorize`. The surface and academy come from the HOST. */
export class GoogleAuthorizeDto {
  @IsIn(['sign_in', 'sign_up', 'link', 'setup'])
  readonly intent!: 'sign_in' | 'sign_up' | 'link' | 'setup';

  /** A relative path to land on afterwards; anything else is dropped. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  readonly returnTo?: string;

  /** Platform host / local development only (the preview parameter); refused on a mismatching academy host. */
  @IsOptional()
  @IsUUID()
  readonly academyId?: string;

  /** `link` only — the account's current password (re-authentication). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  readonly currentPassword?: string;

  /** `setup` only — the raw token from the invitation/setup link. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  readonly setupToken?: string;
}

/**
 * An academy's invitation code, for an `invite`-policy academy SIGN-UP by an
 * account that already exists. Authorization context, not identity: it is
 * checked and spent only by the canonical `claim_academy_invite` (this
 * flow's academy — fixed from the request host when the flow started — and
 * the ACCOUNT's own email, atomically), exactly as the password join does.
 */
class WithInviteToken {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  readonly inviteToken?: string;
}

/** `POST /auth/google/complete` — the single-use handoff from the URL fragment. */
export class GoogleCompleteDto extends WithInviteToken {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  readonly handoff!: string;
}

/** A follow-up step's single-use reference (`googleStep` responses). */
export class GoogleStepDto extends WithInviteToken {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  readonly pending!: string;
}

/** `POST /auth/google/link` — the existing account's own password. */
export class GoogleLinkDto extends GoogleStepDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(256)
  readonly password!: string;
}

/** `POST /auth/google/create-account`. The email is Google's, never the body's. */
export class GoogleCreateAccountDto extends GoogleStepDto {
  /** Same rule as the password signup's `RegisterDto.name`. */
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  readonly name!: string;

  /** Management surface only: the one-page organization signup's fields. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readonly organizationName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  readonly planId?: string;
}

/** `DELETE /users/me/sign-in-methods/google`. */
export class UnlinkGoogleDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(256)
  readonly currentPassword!: string;
}
