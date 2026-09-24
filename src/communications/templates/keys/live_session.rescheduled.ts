import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'A live session was rescheduled',
    paragraphs: (v) => [
      `The live session "${str(v, 'title')}" now starts at ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'Open course',
  }),
  ar: defineLocale({
    subject: () => 'تم تغيير موعد جلسة مباشرة',
    paragraphs: (v) => [
      `أصبح موعد الجلسة المباشرة "${str(v, 'title')}" في ${str(v, 'startsAt')}.`,
    ],
    ctaLabel: 'فتح الدورة',
  }),
};
