import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T2 — one reminder, a day ahead. With a 72-hour trial a "3 days
 * left" mail would duplicate T1 and a 48-hour one is noise; this is the
 * single reminder that leaves enough time to start a manual transfer,
 * which itself needs review time.
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
