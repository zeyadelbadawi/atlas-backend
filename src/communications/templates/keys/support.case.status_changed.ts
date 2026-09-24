import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Support case "${str(v, 'subject')}" is now ${str(v, 'status')}`,
    paragraphs: (v) => [
      `The status of your support case "${str(v, 'subject')}" changed to ${str(v, 'status')}.`,
    ],
    ctaLabel: 'Open case',
  }),
  ar: defineLocale({
    subject: (v) => `تغيّرت حالة طلب الدعم "${str(v, 'subject')}"`,
    paragraphs: (v) => [
      `تغيّرت حالة طلب الدعم "${str(v, 'subject')}" إلى ${str(v, 'status')}.`,
    ],
    ctaLabel: 'فتح الطلب',
  }),
};
