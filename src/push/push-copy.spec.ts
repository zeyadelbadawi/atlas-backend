import { pushBody, pushTitle } from './push-copy';

describe('push copy', () => {
  it('names only the kind of update, in the device language', () => {
    expect(pushBody('billing', 'en')).toBe('There is an update about a payment.');
    expect(pushBody('announcement', 'ar')).toBe('لديك إعلان جديد.');
  });

  it('titles with the academy name, or Atlas for account notices', () => {
    expect(pushTitle('  Ziadd  ', 'ar')).toBe('Ziadd');
    expect(pushTitle(null, 'ar')).toBe('أطلس');
    expect(pushTitle('', 'en')).toBe('Atlas');
  });
});
