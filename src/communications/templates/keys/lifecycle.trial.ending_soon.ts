import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T2 — the last reminder, a day ahead. A trial of a week or more
 * (the 14-day trial) also gets T2a three days ahead
 * (`lifecycle.trial.ending_in_3_days`, B0-MSG-05); a short trial gets only
 * this one, since a "3 days left" mail would arrive as it started.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your trial ends tomorrow',
    paragraphs: (v) => [
      `Your trial ends on ${str(v, 'trialEndsAtDate')} — about a day from now.`,
      'Payment is reviewed by a person, so starting a bank or wallet transfer today is what keeps your site online without a gap.',
      'If the trial ends first, your public website goes offline and changes are blocked until a plan is active. Nothing is deleted.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: () => 'تنتهي فترتك التجريبية غدًا',
    paragraphs: (v) => [
      `تنتهي فترتك التجريبية في ${str(v, 'trialEndsAtDate')}، أي بعد نحو يوم من الآن.`,
      'تتم مراجعة الدفع بواسطة موظف، لذا فإن بدء التحويل البنكي أو عبر المحفظة اليوم هو ما يبقي موقعك متاحًا دون انقطاع.',
      'إذا انتهت الفترة التجريبية أولًا، سيتوقف عرض موقعك العام وستُمنع التعديلات حتى تُفعَّل خطة. لن يُحذف أي شيء.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
