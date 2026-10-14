import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SUP-01 — a customer opened a support case. Platform Owners only. The
 * subject and description are the customer's own text and stay on the
 * case; the call to action opens it.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New support case from ${str(v, 'organizationName', 'a customer')}`,
    preheader: () => 'A customer is waiting for a first response.',
    paragraphs: (v) => [
      `${str(v, 'organizationName', 'A customer')} opened a new support case.`,
      'Open the case to read it and reply.',
    ],
    ctaLabel: 'Open support case',
  }),
  ar: defineLocale({
    subject: (v) => `طلب دعم جديد من ${str(v, 'organizationName', 'أحد العملاء')}`,
    preheader: () => 'عميل في انتظار أول رد.',
    paragraphs: (v) => [
      `فتحت ${str(v, 'organizationName', 'جهة عميلة')} طلب دعم جديدًا.`,
      'افتح الطلب لقراءته والرد عليه.',
    ],
    ctaLabel: 'فتح طلب الدعم',
  }),
};
