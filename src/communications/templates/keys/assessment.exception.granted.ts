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
 * A reviewer granted this learner an exception on one quiz (W-EXC).
 *
 * ONE event, TWO messages, chosen by `scheduled` — the flag the producer
 * derived from `availableFrom` at the moment it wrote the row:
 *
 *   - ACTIVE NOW (no `availableFrom`, or it is already past): the learner
 *     is told they can use it, and the button is an invitation.
 *   - SCHEDULED: the learner is told the date it opens and told plainly
 *     that nothing has changed yet. Sending "you have extra time, go and
 *     use it" for a window that opens next Tuesday is worse than sending
 *     nothing — a learner who acts on it starts an ordinary attempt under
 *     the ordinary time limit believing they have longer.
 *
 * The button is the same, neutral destination in both cases (the activity
 * page, where the real state is shown); only the copy around it moves.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      v.scheduled === true
        ? `An exception for "${str(v, 'quizTitle', 'a quiz')}" starts on ${str(v, 'availableFromLabel')}`
        : `You have an exception for "${str(v, 'quizTitle', 'a quiz')}"`,
    preheader: (v) =>
      v.scheduled === true
        ? `It is not active yet — it opens on ${str(v, 'availableFromLabel')}.`
        : 'It applies to your next attempt.',
    paragraphs: (v) =>
      v.scheduled === true
        ? lines(
            `${str(v, 'academyName', 'Your academy')} has set up an exception for you on the quiz "${str(v, 'quizTitle', 'a quiz')}".`,
            adjustmentsEn(v),
            `It becomes active on ${str(v, 'availableFromLabel')}.`,
            untilEn(v, 'Once it opens, it stays open'),
            'Until then this quiz works exactly as it does for everyone else, so there is nothing for you to do yet.',
          )
        : lines(
            `${str(v, 'academyName', 'Your academy')} has granted you an exception on the quiz "${str(v, 'quizTitle', 'a quiz')}".`,
            adjustmentsEn(v),
            'It is active now and applies to your next attempt.',
            untilEn(v),
          ),
    ctaLabel: 'Open the activity',
  }),
  ar: defineLocale({
    subject: (v) =>
      v.scheduled === true
        ? `يبدأ استثناؤك في «${str(v, 'quizTitle', 'أحد الاختبارات')}» بتاريخ ${str(v, 'availableFromLabel')}`
        : `لديك استثناء في «${str(v, 'quizTitle', 'أحد الاختبارات')}»`,
    preheader: (v) =>
      v.scheduled === true
        ? `لم يبدأ سريانه بعد، ويبدأ في ${str(v, 'availableFromLabel')}.`
        : 'ينطبق على محاولتك القادمة.',
    paragraphs: (v) =>
      v.scheduled === true
        ? lines(
            `أعدّت ${str(v, 'academyName', 'أكاديميتك')} استثناءً خاصًا بك في اختبار «${str(v, 'quizTitle', 'أحد الاختبارات')}».`,
            adjustmentsAr(v),
            `يبدأ سريان هذا الاستثناء في ${str(v, 'availableFromLabel')}.`,
            untilAr(v, 'وعند بدء سريانه تستمر مهلتك'),
            'وحتى ذلك الحين يعمل هذا الاختبار كالمعتاد تمامًا، ولا يلزمك أي إجراء الآن.',
          )
        : lines(
            `منحتك ${str(v, 'academyName', 'أكاديميتك')} استثناءً في اختبار «${str(v, 'quizTitle', 'أحد الاختبارات')}».`,
            adjustmentsAr(v),
            'هذا الاستثناء ساري الآن وينطبق على محاولتك القادمة.',
            untilAr(v),
          ),
    ctaLabel: 'فتح النشاط',
  }),
};
