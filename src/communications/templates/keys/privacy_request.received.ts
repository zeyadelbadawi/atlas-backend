/**
 * B0-SEC-13 — to the requester: their privacy request was received. No
 * handling time is promised (no SLA is published, OQ-23).
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
        ? 'We received your request to delete your account'
        : 'We received your request for a copy of your data',
    paragraphs: (v, ctx) => [
      isDeletion(v)
        ? `We received your request to delete your ${ctx.branding.platformName} account and the personal data linked to it.`
        : `We received your request for a copy of the personal data your ${ctx.branding.platformName} account holds.`,
      'Our team will handle it and email you when it is done. You can follow its status on your profile.',
      isDeletion(v)
        ? 'Until then your account keeps working as normal.'
        : 'When the copy is ready, you will download it from your profile while signed in.',
    ],
    ctaLabel: 'View your profile',
  }),
  ar: defineLocale({
    subject: (v) =>
      isDeletion(v) ? 'تلقّينا طلب حذف حسابك' : 'تلقّينا طلب الحصول على نسخة من بياناتك',
    paragraphs: (v, ctx) => [
      isDeletion(v)
        ? `تلقّينا طلبك حذف حسابك على ${ctx.branding.platformName} والبيانات الشخصية المرتبطة به.`
        : `تلقّينا طلبك الحصول على نسخة من البيانات الشخصية التي يحتفظ بها حسابك على ${ctx.branding.platformName}.`,
      'سيتولى فريقنا الطلب وسنراسلك عند الانتهاء منه. يمكنك متابعة حالته من ملفك الشخصي.',
      isDeletion(v)
        ? 'حتى ذلك الحين يظل حسابك يعمل كالمعتاد.'
        : 'عندما تجهز النسخة، ستنزّلها من ملفك الشخصي بعد تسجيل الدخول.',
    ],
    ctaLabel: 'عرض ملفك الشخصي',
  }),
};
