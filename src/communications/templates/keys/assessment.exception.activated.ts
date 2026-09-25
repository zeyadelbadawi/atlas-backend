import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import {
  adjustmentsAr,
  adjustmentsEn,
  lines,
  untilAr,
  untilEn,
} from './assessment.exception.copy';

/**
 * The moment a SCHEDULED exception actually opened (W-EXC).
 *
 * This is the second half of the promise the `granted` email made when it
 * said "it becomes active on <date>" and deliberately told the learner to
 * do nothing yet. Without it the learner has to remember a date and guess
 * whether the system agreed with them.
 *
 * Only ever sent for an exception that WAS scheduled — one that was
 * already active when it was granted said so at the time, and saying it
 * twice is noise.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your exception for "${str(v, 'quizTitle', 'a quiz')}" is now active`,
    preheader: () => 'It applies from now on.',
    paragraphs: (v) =>
      lines(
        `The exception ${str(v, 'academyName', 'your academy')} set up for you on the quiz "${str(v, 'quizTitle', 'a quiz')}" has just become active.`,
        adjustmentsEn(v),
        'It applies to your next attempt.',
        untilEn(v),
      ),
    ctaLabel: 'Open the activity',
  }),
  ar: defineLocale({
    subject: (v) =>
      `أصبح استثناؤك في «${str(v, 'quizTitle', 'أحد الاختبارات')}» ساريًا الآن`,
    preheader: () => 'ينطبق اعتبارًا من الآن.',
    paragraphs: (v) =>
      lines(
        `بدأ الآن سريان الاستثناء الذي أعدّته لك ${str(v, 'academyName', 'أكاديميتك')} في اختبار «${str(v, 'quizTitle', 'أحد الاختبارات')}».`,
        adjustmentsAr(v),
        'وينطبق على محاولتك القادمة.',
        untilAr(v),
      ),
    ctaLabel: 'فتح النشاط',
  }),
};
