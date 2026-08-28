/**
 * `PlatformConfiguration` response contract — matches
 * `platform-settings.types.ts` (atlas frontend) field-for-field.
 * `sessionTimeoutMinutes` translates the stored nullable `Int` (P15
 * migration) to the frontend's `15 | 30 | 60 | 'never'` union — `null`
 * (never) is the one value that cannot round-trip through a plain
 * `Int?` DTO field without this explicit mapping.
 */
import type { PlatformSettings } from '@prisma/client';

export type PlatformSessionTimeout = 15 | 30 | 60 | 'never';

export interface PlatformConfigurationResponse {
  readonly platformName: string;
  readonly platformDescription?: string;
  readonly supportEmail?: string;
  readonly twoFactorRequired: boolean;
  readonly sessionTimeoutMinutes: PlatformSessionTimeout;
}

export function toPlatformConfigurationResponse(
  settings: PlatformSettings,
): PlatformConfigurationResponse {
  return {
    platformName: settings.platformName,
    platformDescription: settings.platformDescription ?? undefined,
    supportEmail: settings.supportEmail ?? undefined,
    twoFactorRequired: settings.twoFactorRequired,
    sessionTimeoutMinutes:
      settings.sessionTimeoutMinutes === null
        ? 'never'
        : (settings.sessionTimeoutMinutes as 15 | 30 | 60),
  };
}
