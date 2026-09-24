import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'A live session was scheduled',
    paragraphs: (v) => [
      `A live session "${str(v, 'title')}" has been scheduled for ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'Open course',
  }),
  ar: defineLocale({
    subject: () => 'تمت جدولة جلسة مباشرة',
    paragraphs: (v) => [
      `تمت جدولة جلسة مباشرة "${str(v, 'title')}" في ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'فتح الدورة',
  }),
};
