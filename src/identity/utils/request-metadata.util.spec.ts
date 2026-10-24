import { deriveDeviceLabel } from './request-metadata.util';

describe('deriveDeviceLabel (session list)', () => {
  it.each([
    ['AtlasApp/1.0.0 (iPhone; iOS 18.0)', 'Atlas app on iOS'],
    ['AtlasApp/1.0.0 (Android 15)', 'Atlas app on Android'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Chrome on macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
  ])('%s → %s', (userAgent, expected) => {
    expect(deriveDeviceLabel(userAgent)).toBe(expected);
  });

  it('does not treat a look-alike agent as the app', () => {
    expect(deriveDeviceLabel('AtlasBot/1.0 (+https://example.test)')).toBeUndefined();
  });

  it('is undefined with no agent', () => {
    expect(deriveDeviceLabel(undefined)).toBeUndefined();
  });
});
