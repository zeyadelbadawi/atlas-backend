import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * A timed attempt closed itself (plan §8 E4). `reason` is the engine's
 * own `FinalizeReason`: `timeout` (the clock ran out) or `integrity` (the
 * attempt was auto-submitted by the integrity rule). Both mean the same
 * thing to the learner — the attempt ended without them pressing submit —
 * so one key carries both, with the reason changing only the sentence
 * that explains WHY.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `${str(v, 'quizTitle', 'Your quiz')} was submitted automatically`,
    preheader: () => 'Your answers were saved and submitted for you.',
    paragraphs: (v) => [
      str(v, 'reason') === 'integrity'
        ? `Your attempt at ${str(v, 'quizTitle', 'a quiz')} was submitted automatically because it was flagged by the quiz integrity rules.`
        : `Time ran out on your attempt at ${str(v, 'quizTitle', 'a quiz')}, so it was submitted automatically.`,
      'The answers you had saved were kept and graded. Open the quiz to see the result.',
    ],
    ctaLabel: 'See the result',
  }),
  ar: defineLocale({
    subject: (v) => `تم تسليم ${str(v, 'quizTitle', 'اختبارك')} تلقائيًا`,
    preheader: () => 'تم حفظ إجاباتك وتسليمها نيابة عنك.',
    paragraphs: (v) => [
      str(v, 'reason') === 'integrity'
        ? `تم تسليم محاولتك في ${str(v, 'quizTitle', 'الاختبار')} تلقائيًا لأنها خالفت قواعد نزاهة الاختبار.`
        : `انتهى الوقت المخصص لمحاولتك في ${str(v, 'quizTitle', 'الاختبار')}، لذلك تم تسليمها تلقائيًا.`,
      'تم الاحتفاظ بالإجابات التي حفظتها وتصحيحها. افتح الاختبار لعرض النتيجة.',
    ],
    ctaLabel: 'عرض النتيجة',
  }),
};
