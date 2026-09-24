import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'A live session is starting soon',
    paragraphs: (v) => [
      `The live session "${str(v, 'title')}" starts at ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'Open course',
  }),
  ar: defineLocale({
    subject: () => 'جلسة مباشرة تبدأ قريبًا',
    paragraphs: (v) => [
      `تبدأ الجلسة المباشرة "${str(v, 'title')}" في ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'فتح الدورة',
  }),
};
