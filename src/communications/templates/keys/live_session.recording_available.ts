import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your session recording is ready',
    paragraphs: (v) => [
      `The recording for "${str(v, 'title')}" has finished processing and is now in your academy's media library.`,
    ],
    ctaLabel: 'Open recordings',
  }),
  ar: defineLocale({
    subject: () => 'تسجيل جلستك جاهز',
    paragraphs: (v) => [
      `اكتملت معالجة تسجيل "${str(v, 'title')}" وأصبح متاحًا في مكتبة وسائط أكاديميتك.`,
    ],
    ctaLabel: 'فتح التسجيلات',
  }),
};
