import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'A live session was cancelled',
    paragraphs: (v) => [`The live session "${str(v, 'title')}" has been cancelled.`],
    ctaLabel: 'Open course',
  }),
  ar: defineLocale({
    subject: () => 'تم إلغاء جلسة مباشرة',
    paragraphs: (v) => [`تم إلغاء الجلسة المباشرة "${str(v, 'title')}".`],
    ctaLabel: 'فتح الدورة',
  }),
};
