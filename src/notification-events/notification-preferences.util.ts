/**
 * The single default `NotificationPreferences` value used everywhere a
 * user's `preferences.notifications` sub-object is missing (a fresh
 * account's `users.preferences` JSON defaults to `{}` — see
 * `schema.prisma`'s own `User.preferences` doc comment). Only `email`
 * reflects a real, working delivery channel in this codebase (no push/SMS
 * provider exists anywhere — master plan §21 P17: "do not pretend Push or
 * SMS delivery exists if no provider/infrastructure exists"), so only it
 * defaults on. Shared by `NotificationsService` (the read/`GET
 * .../preferences` side) and `NotificationFanoutService` (the "should I
 * actually send an email" check) so the two can never silently disagree.
 */
export interface StoredNotificationPreferences {
  readonly email: boolean;
  readonly push: boolean;
  readonly sms: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: StoredNotificationPreferences = {
  email: true,
  push: false,
  sms: false,
};

export function resolveNotificationPreferences(
  preferencesJson: unknown,
): StoredNotificationPreferences {
  const notifications = (
    preferencesJson as { notifications?: Partial<StoredNotificationPreferences> } | null
  )?.notifications;
  if (!notifications) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    email: notifications.email ?? DEFAULT_NOTIFICATION_PREFERENCES.email,
    push: notifications.push ?? DEFAULT_NOTIFICATION_PREFERENCES.push,
    sms: notifications.sms ?? DEFAULT_NOTIFICATION_PREFERENCES.sms,
  };
}
