import { toPlatformConfigurationResponse } from './platform-settings.contract';
import type { PlatformSettings } from '@prisma/client';

function buildSettings(overrides: Partial<PlatformSettings> = {}): PlatformSettings {
  return {
    id: 'singleton',
    platformName: 'Atlas',
    platformDescription: null,
    supportEmail: null,
    twoFactorRequired: false,
    sessionTimeoutMinutes: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('toPlatformConfigurationResponse', () => {
  it('maps a null sessionTimeoutMinutes to the frontend\'s "never" literal', () => {
    const response = toPlatformConfigurationResponse(
      buildSettings({ sessionTimeoutMinutes: null }),
    );
    expect(response.sessionTimeoutMinutes).toBe('never');
  });

  it.each([15, 30, 60])(
    'maps a stored sessionTimeoutMinutes of %d through unchanged',
    (minutes) => {
      const response = toPlatformConfigurationResponse(
        buildSettings({ sessionTimeoutMinutes: minutes }),
      );
      expect(response.sessionTimeoutMinutes).toBe(minutes);
    },
  );

  it('maps null platformDescription/supportEmail to undefined, never a literal "null" string', () => {
    const response = toPlatformConfigurationResponse(
      buildSettings({ platformDescription: null, supportEmail: null }),
    );
    expect(response.platformDescription).toBeUndefined();
    expect(response.supportEmail).toBeUndefined();
  });
});
