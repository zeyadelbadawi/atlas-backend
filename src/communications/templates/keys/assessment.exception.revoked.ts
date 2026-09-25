import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { lines } from './assessment.exception.copy';

/**
 * The exception was removed (W-EXC).
 *
 * The counterpart of `granted`, and the reason the grant is worth
 * announcing at all: a learner who was told they had 1.5× the time plans
 * an exam around it. Silence here leaves them planning around something
 * that is no longer true, and they find out when the timer runs out.
 *
 * The copy states the consequence in the learner's own terms — the
 * ordinary limit and the ordinary number of attempts apply again — rather
 * than reporting a row that was deleted.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your exception for "${str(v, 'quizTitle', 'a quiz')}" has been removed`,
    preheader: () => 'The usual time limit and attempts apply again.',
    paragraphs: (v) =>
      lines(
        `${str(v, 'academyName', 'Your academy')} has removed the exception you had on the quiz "${str(v, 'quizTitle', 'a quiz')}".`,
        'From now on this quiz has the same time limit, the same number of attempts and the same dates for you as for everyone else.',
        'If you were relying on the extra time, speak to your instructor before you start your next attempt.',
      ),
    ctaLabel: 'Open the activity',
  }),
  ar: defineLocale({
    subject: (v) => `تم إلغاء استثنائك في «${str(v, 'quizTitle', 'أحد الاختبارات')}»`,
    preheader: () => 'عادت المهلة وعدد المحاولات المعتادة للتطبيق.',
    paragraphs: (v) =>
      lines(
        `ألغت ${str(v, 'academyName', 'أكاديميتك')} الاستثناء الذي كان ممنوحًا لك في اختبار «${str(v, 'quizTitle', 'أحد الاختبارات')}».`,
        'واعتبارًا من الآن تنطبق عليك المهلة نفسها وعدد المحاولات نفسه والمواعيد نفسها المطبّقة على الجميع.',
        'وإذا كنت تعتمد على الوقت الإضافي، فتواصل مع مدرّسك قبل بدء محاولتك القادمة.',
      ),
    ctaLabel: 'فتح النشاط',
  }),
};
