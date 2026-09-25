import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** A reviewer voided a quiz attempt (plan §8 E5). Plain, non-accusatory copy. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your attempt at ${str(v, 'quizTitle', 'a quiz')} no longer counts`,
    preheader: () => 'It has been removed from your result for this quiz.',
    paragraphs: (v) => {
      const lines = [
        `An attempt at ${str(v, 'quizTitle', 'a quiz')} was voided by ${str(v, 'academyName', 'your academy')} and no longer counts toward your result.`,
      ];
      const reason = str(v, 'reason');
      if (reason) lines.push(`Reason given: ${reason}`);
      lines.push('Contact the academy if you think this is a mistake.');
      return lines;
    },
    ctaLabel: 'Open the quiz',
  }),
  ar: defineLocale({
    subject: (v) => `لم تعد محاولتك في ${str(v, 'quizTitle', 'الاختبار')} محتسبة`,
    preheader: () => 'تمت إزالتها من نتيجتك في هذا الاختبار.',
    paragraphs: (v) => {
      const lines = [
        `تم إلغاء محاولة في ${str(v, 'quizTitle', 'الاختبار')} من قِبل ${str(v, 'academyName', 'أكاديميتك')}، ولم تعد تُحتسب ضمن نتيجتك.`,
      ];
      const reason = str(v, 'reason');
      if (reason) lines.push(`السبب المذكور: ${reason}`);
      lines.push('تواصل مع الأكاديمية إذا كنت ترى أن هذا خطأ.');
      return lines;
    },
    ctaLabel: 'فتح الاختبار',
  }),
};
