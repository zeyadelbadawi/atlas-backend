import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  resolveNotificationPreferences,
} from './notification-preferences.util';

describe('resolveNotificationPreferences', () => {
  it('returns the default when preferences JSON is null/undefined', () => {
    expect(resolveNotificationPreferences(null)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
    expect(resolveNotificationPreferences(undefined)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it('returns the default when the `notifications` sub-object is absent', () => {
    expect(resolveNotificationPreferences({ theme: 'dark' })).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it('returns the stored value when present', () => {
    expect(
      resolveNotificationPreferences({
        notifications: { email: false, push: true, sms: true },
      }),
    ).toEqual({ email: false, push: true, sms: true });
  });

  it('fills in only the missing fields from the default (never fabricates a fully-defaulted object for a partially-stored one)', () => {
    expect(resolveNotificationPreferences({ notifications: { email: false } })).toEqual({
      email: false,
      push: DEFAULT_NOTIFICATION_PREFERENCES.push,
      sms: DEFAULT_NOTIFICATION_PREFERENCES.sms,
    });
  });

  it('only email defaults on — no push/SMS provider exists in this codebase', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      email: true,
      push: false,
      sms: false,
    });
  });
});
