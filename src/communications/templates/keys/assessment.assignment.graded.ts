import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your assignment has been graded',
    paragraphs: (v) => [
      `Your assignment "${str(v, 'assignmentTitle')}" has been graded${
        str(v, 'score') ? ` with a score of ${str(v, 'score')}` : ''
      }.`,
      'Open the activity to read the feedback.',
    ],
    ctaLabel: 'Open activity',
  }),
  ar: defineLocale({
    subject: () => 'تم تقييم واجبك',
    paragraphs: (v) => [
      `تم تقييم واجبك "${str(v, 'assignmentTitle')}"${
        str(v, 'score') ? ` بدرجة ${str(v, 'score')}` : ''
      }.`,
      'افتح النشاط لقراءة الملاحظات.',
    ],
    ctaLabel: 'فتح النشاط',
  }),
};
