import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePlatformSettingsDto } from './update-platform-settings.dto';

describe('UpdatePlatformSettingsDto', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(UpdatePlatformSettingsDto, payload);
    return validate(dto);
  }

  it('accepts an empty payload (every field optional — genuine partial update)', async () => {
    const errors = await validateDto({});
    expect(errors).toHaveLength(0);
  });

  it('accepts a General-settings-only payload', async () => {
    const errors = await validateDto({
      platformName: 'Atlas',
      platformDescription: 'The platform',
      supportEmail: 'support@atlas.example',
    });
    expect(errors).toHaveLength(0);
  });

  it.each([15, 30, 60, 'never'])('accepts sessionTimeoutMinutes = %p', async (value) => {
    const errors = await validateDto({ sessionTimeoutMinutes: value });
    expect(errors).toHaveLength(0);
  });

  it.each([45, 0, 90, 'sometimes', null])(
    'rejects sessionTimeoutMinutes = %p',
    async (value) => {
      const errors = await validateDto({ sessionTimeoutMinutes: value });
      expect(errors.some((e) => e.property === 'sessionTimeoutMinutes')).toBe(true);
    },
  );

  it('rejects an invalid supportEmail', async () => {
    const errors = await validateDto({ supportEmail: 'not-an-email' });
    expect(errors.some((e) => e.property === 'supportEmail')).toBe(true);
  });

  it('accepts a boolean twoFactorRequired', async () => {
    const errors = await validateDto({ twoFactorRequired: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-boolean twoFactorRequired', async () => {
    const errors = await validateDto({ twoFactorRequired: 'yes' });
    expect(errors.some((e) => e.property === 'twoFactorRequired')).toBe(true);
  });

  it('rejects an over-length platformName', async () => {
    const errors = await validateDto({ platformName: 'x'.repeat(200) });
    expect(errors.some((e) => e.property === 'platformName')).toBe(true);
  });
});
