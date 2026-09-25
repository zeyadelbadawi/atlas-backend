import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** §27 S6 — the day before the grace window closes. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your grace period ends tomorrow',
    paragraphs: (v) => [
      `Your grace period ends on ${str(v, 'graceEndsAtDate')} — about a day from now.`,
      'After that your public website stops being served and changes are blocked until a payment is approved.',
      'Nothing is deleted, and approving a payment restores everything.',
    ],
    ctaLabel: 'Pay now',
  }),
  ar: defineLocale({
    subject: () => 'تنتهي مهلة السماح غدًا',
    paragraphs: (v) => [
      `تنتهي مهلة السماح في ${str(v, 'graceEndsAtDate')}، أي بعد نحو يوم من الآن.`,
      'بعدها يتوقف عرض موقعك العام وتُمنع التعديلات حتى تتم الموافقة على دفعة.',
      'لن يُحذف أي شيء، والموافقة على الدفع تعيد كل شيء.',
    ],
    ctaLabel: 'ادفع الآن',
  }),
};
