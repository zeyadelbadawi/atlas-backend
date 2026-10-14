/**
 * B0-SEC-13 — to the requester: the copy of their data can be downloaded
 * from their profile until a date. The file itself is never attached or
 * linked: it is fetched by the signed-in account only.
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your copy of your data is ready',
    paragraphs: (v) => [
      'The copy of your personal data you asked for is ready.',
      `Sign in and open your profile to download it. It is available until ${str(v, 'availableUntilDate')}.`,
      'If you did not ask for this, change your password and contact us.',
    ],
    ctaLabel: 'Open your profile',
  }),
  ar: defineLocale({
    subject: () => 'نسخة بياناتك جاهزة',
    paragraphs: (v) => [
      'نسخة بياناتك الشخصية التي طلبتها جاهزة.',
      `سجّل الدخول وافتح ملفك الشخصي لتنزيلها. تبقى متاحة حتى ${str(v, 'availableUntilDate')}.`,
      'إذا لم تطلب ذلك، فغيّر كلمة المرور وتواصل معنا.',
    ],
    ctaLabel: 'فتح ملفك الشخصي',
  }),
};
