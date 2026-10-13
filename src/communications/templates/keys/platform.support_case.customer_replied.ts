import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SUP-01 — a customer replied on a support case. Platform Owners only.
 * The reply itself stays on the case; the call to action opens it.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `New reply on a support case from ${str(v, 'organizationName', 'a customer')}`,
    preheader: () => 'A customer replied on a support case.',
    paragraphs: (v) => [
      `${str(v, 'organizationName', 'A customer')} replied on a support case.`,
      'Open the case to read the reply and answer it.',
    ],
    ctaLabel: 'Open support case',
  }),
  ar: defineLocale({
    subject: (v) => `رد جديد على طلب دعم من ${str(v, 'organizationName', 'أحد العملاء')}`,
    preheader: () => 'ردّ عميل على طلب دعم.',
    paragraphs: (v) => [
      `ردّت ${str(v, 'organizationName', 'جهة عميلة')} على طلب دعم.`,
      'افتح الطلب لقراءة الرد والإجابة عليه.',
    ],
    ctaLabel: 'فتح طلب الدعم',
  }),
};
