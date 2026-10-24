/**
 * What a push says on the lock screen.
 *
 * Deliberately general: the title is the academy's name and the body names
 * only the kind of update, in the device's language. The notification's
 * real wording, values and links stay inside the app's feed, so nothing
 * personal (a grade, a payment amount, a course a parent might see) is
 * shown on a locked phone.
 */
import type { NotificationType } from '@prisma/client';

export type PushLocale = 'en' | 'ar';

const BODY: Readonly<Record<NotificationType, Readonly<Record<PushLocale, string>>>> = {
  activity: {
    en: 'There is an update in one of your courses.',
    ar: 'يوجد تحديث جديد في إحدى دوراتك.',
  },
  announcement: {
    en: 'You have a new announcement.',
    ar: 'لديك إعلان جديد.',
  },
  billing: {
    en: 'There is an update about a payment.',
    ar: 'يوجد تحديث بخصوص عملية دفع.',
  },
  security: {
    en: 'Security notice for your account.',
    ar: 'تنبيه أمني بخصوص حسابك.',
  },
  account: {
    en: 'There is an update about your account.',
    ar: 'يوجد تحديث بخصوص حسابك.',
  },
  system: {
    en: 'You have a new notification.',
    ar: 'لديك إشعار جديد.',
  },
};

const PLATFORM_TITLE: Readonly<Record<PushLocale, string>> = { en: 'Atlas', ar: 'أطلس' };

export function pushBody(type: NotificationType, locale: PushLocale): string {
  return BODY[type]?.[locale] ?? BODY.system[locale];
}

/** The academy's name, or Atlas for an account-wide notice. */
export function pushTitle(academyName: string | null, locale: PushLocale): string {
  const name = academyName?.trim();
  return name ? name.slice(0, 120) : PLATFORM_TITLE[locale];
}
