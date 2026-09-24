import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'A certificate was revoked',
    paragraphs: (v) => [
      `Your certificate for "${str(v, 'courseTitle')}" from ${str(v, 'academyName')} has been revoked.`,
      'Contact the academy if you have a question about this.',
    ],
    ctaLabel: 'View certificates',
  }),
  ar: defineLocale({
    subject: () => 'تم إلغاء شهادة',
    paragraphs: (v) => [
      `تم إلغاء شهادتك لدورة "${str(v, 'courseTitle')}" من ${str(v, 'academyName')}.`,
      'تواصل مع الأكاديمية إذا كان لديك استفسار.',
    ],
    ctaLabel: 'عرض الشهادات',
  }),
};
