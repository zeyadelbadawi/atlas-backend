/**
 * `PATCH /users/me/preferences` — matches
 * `CurrentUserService.updatePreferences({ preferences })`, whose body
 * shape is `{ preferences: Partial<UserPreferences> }`, and `UserPreferences`
 * itself (`identity.types.ts`): `{ theme?, language?, notifications? }`
 * where `notifications` is the full `{ email, push, sms }` object, not
 * itself partial — a caller that wants to change one notification channel
 * sends the whole `notifications` object, matching the frontend type
 * exactly. No new preference categories are invented.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

// See `RegisterDto`'s comment: `@IsNotEmpty()` is what actually rejects a
// missing required field (class-validator's other decorators skip
// undefined values silently). `IsNotEmpty`'s "empty" check only fires on
// `undefined`/`null`/`''` — never on `false` — so it's safe on booleans.
export class NotificationPreferencesDto {
  @IsNotEmpty()
  @IsBoolean()
  readonly email!: boolean;

  @IsNotEmpty()
  @IsBoolean()
  readonly push!: boolean;

  @IsNotEmpty()
  @IsBoolean()
  readonly sms!: boolean;
}

export class UserPreferencesInputDto {
  @IsOptional()
  @IsString()
  readonly theme?: string;

  @IsOptional()
  @IsString()
  readonly language?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationPreferencesDto)
  readonly notifications?: NotificationPreferencesDto;
}

export class UpdatePreferencesDto {
  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => UserPreferencesInputDto)
  readonly preferences!: UserPreferencesInputDto;
}
