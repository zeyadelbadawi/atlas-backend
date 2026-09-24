import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New reply on "${str(v, 'subject')}"`,
    paragraphs: (v) => [
      `There is a new reply on your support case "${str(v, 'subject')}".`,
      'Open the case to read it and answer.',
    ],
    ctaLabel: 'Open case',
  }),
  ar: defineLocale({
    subject: (v) => `رد جديد على "${str(v, 'subject')}"`,
    paragraphs: (v) => [
      `هناك رد جديد على طلب الدعم "${str(v, 'subject')}".`,
      'افتح الطلب لقراءته والرد عليه.',
    ],
    ctaLabel: 'فتح الطلب',
  }),
};
