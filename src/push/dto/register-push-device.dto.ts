import {
  IsBoolean,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const PUSH_LOCALES = ['en', 'ar'] as const;

/** `PUT /users/me/push-devices` — the app's FCM token for this install. */
export class RegisterPushDeviceDto {
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  @Matches(/^[\x21-\x7e]+$/, { message: 'token must be printable ASCII' })
  readonly token!: string;

  @IsIn(PUSH_PLATFORMS)
  readonly platform!: (typeof PUSH_PLATFORMS)[number];

  @IsString()
  @Matches(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)
  readonly appVersion!: string;

  @IsIn(PUSH_LOCALES)
  readonly locale!: (typeof PUSH_LOCALES)[number];

  /**
   * A push the day before a quiz or assignment is due. Left out (older
   * app versions) → a new device is off and an existing one keeps its value.
   */
  @ValidateIf((_, value) => value !== undefined) // null is refused, not skipped
  @IsBoolean()
  readonly dueReminders?: boolean;
}
