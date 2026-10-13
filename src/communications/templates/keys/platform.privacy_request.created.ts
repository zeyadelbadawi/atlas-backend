import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SEC-13 — a person filed a privacy request. Platform Owners only. No
 * personal data in the alert; the call to action opens the request.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      str(v, 'requestType') === 'deletion'
        ? 'New privacy request: account deletion'
        : 'New privacy request: data export',
    preheader: () => 'A person is waiting for their privacy request to be handled.',
    paragraphs: (v) => [
      str(v, 'requestType') === 'deletion'
        ? 'A person asked for their account to be deleted.'
        : 'A person asked for a copy of their data.',
      'Open the request to handle it.',
    ],
    ctaLabel: 'Open privacy request',
  }),
  ar: defineLocale({
    subject: (v) =>
      str(v, 'requestType') === 'deletion'
        ? 'طلب خصوصية جديد: حذف حساب'
        : 'طلب خصوصية جديد: تصدير بيانات',
    preheader: () => 'شخص في انتظار معالجة طلب الخصوصية الخاص به.',
    paragraphs: (v) => [
      str(v, 'requestType') === 'deletion'
        ? 'طلب شخص حذف حسابه.'
        : 'طلب شخص نسخة من بياناته.',
      'افتح الطلب لمعالجته.',
    ],
    ctaLabel: 'فتح طلب الخصوصية',
  }),
};
