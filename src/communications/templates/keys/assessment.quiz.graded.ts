import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your quiz has been graded',
    paragraphs: (v) => [
      `Grading of your quiz "${str(v, 'quizTitle')}" is complete.`,
      'Open the activity to see the result.',
    ],
    ctaLabel: 'Open activity',
  }),
  ar: defineLocale({
    subject: () => 'اكتمل تقييم اختبارك',
    paragraphs: (v) => [
      `اكتمل تقييم اختبارك "${str(v, 'quizTitle')}".`,
      'افتح النشاط لمشاهدة النتيجة.',
    ],
    ctaLabel: 'فتح النشاط',
  }),
};
