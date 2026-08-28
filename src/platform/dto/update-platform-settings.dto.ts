/**
 * `PATCH /platform-settings` request — matches `Partial<PlatformConfiguration>`
 * (atlas frontend `PlatformSettingsService.updateConfiguration`) exactly:
 * every field optional (a genuine partial update — `GeneralSettings`/
 * `SecuritySettings` each submit only their own fields, confirmed by
 * reading both forms directly), every field validated server-side when
 * present. `MAX_SESSION_TIMEOUT_VALUES` mirrors `PlatformSessionTimeout`
 * (`15 | 30 | 60 | 'never'`) verbatim — no other value is accepted,
 * matching the frontend's own closed union exactly.
 */
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export const ALLOWED_SESSION_TIMEOUT_VALUES: readonly (number | string)[] = [
  15,
  30,
  60,
  'never',
];

export const MAX_PLATFORM_NAME_LENGTH = 100;
export const MAX_PLATFORM_DESCRIPTION_LENGTH = 500;

export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PLATFORM_NAME_LENGTH)
  readonly platformName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_PLATFORM_DESCRIPTION_LENGTH)
  readonly platformDescription?: string;

  @IsOptional()
  @IsEmail()
  readonly supportEmail?: string;

  @IsOptional()
  @IsBoolean()
  readonly twoFactorRequired?: boolean;

  // `@IsOptional()` treats an explicit `null` the SAME as an omitted
  // field (skips all further validation) — wrong here: `null` is not a
  // value `PlatformSessionTimeout` accepts (only `15 | 30 | 60 |
  // 'never'`), so a real client sending `null` must be rejected, while
  // genuinely OMITTING the field (a partial update that doesn't touch
  // this setting) must still be accepted. `@ValidateIf` checking
  // specifically `!== undefined` — not `== null` — draws exactly that
  // line: `undefined` skips validation (omitted), `null` does not
  // (rejected by `@IsIn` below, since it's not in the allowed list).
  @ValidateIf((dto: UpdatePlatformSettingsDto) => dto.sessionTimeoutMinutes !== undefined)
  @IsIn(ALLOWED_SESSION_TIMEOUT_VALUES, {
    message: 'errors.platformSettings.invalidSessionTimeout',
  })
  readonly sessionTimeoutMinutes?: 15 | 30 | 60 | 'never';
}
