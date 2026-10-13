/**
 * B0-SEC-13 — to the requester: the team could not complete their privacy
 * request. The operator's note is the reason given to the person.
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

const isDeletion = (v: Record<string, unknown>): boolean =>
  str(v, 'requestType') === 'deletion';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      isDeletion(v)
        ? 'Update on your request to delete your account'
        : 'Update on your request for a copy of your data',
    paragraphs: (v) =>
      [
        isDeletion(v)
          ? 'We could not complete your request to delete your account.'
          : 'We could not complete your request for a copy of your data.',
        str(v, 'note') ? `Reason: ${str(v, 'note')}` : '',
        'You can file a new request from your profile, or reply to us if something is unclear.',
      ].filter(Boolean),
    ctaLabel: 'View your profile',
  }),
  ar: defineLocale({
    subject: (v) =>
      isDeletion(v) ? 'تحديث بشأن طلب حذف حسابك' : 'تحديث بشأن طلب نسخة من بياناتك',
    paragraphs: (v) =>
      [
        isDeletion(v)
          ? 'لم نتمكن من إتمام طلبك حذف حسابك.'
          : 'لم نتمكن من إتمام طلبك الحصول على نسخة من بياناتك.',
        str(v, 'note') ? `السبب: ${str(v, 'note')}` : '',
        'يمكنك تقديم طلب جديد من ملفك الشخصي، أو التواصل معنا إذا كان هناك ما يحتاج إلى توضيح.',
      ].filter(Boolean),
    ctaLabel: 'عرض ملفك الشخصي',
  }),
};
