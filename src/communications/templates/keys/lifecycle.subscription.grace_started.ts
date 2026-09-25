import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §27 S5 — the paid period ended and the seven-day grace window opened.
 * Not suppressible: a dated deadline after which a paying academy goes
 * dark is a fact, not a nudge.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your site stays online for 7 more days',
    paragraphs: (v) => [
      `Your subscription period ended on ${str(v, 'periodEndDate')} without an approved payment.`,
      `Your site stays online and everything keeps working until ${str(v, 'graceEndsAtDate')}. Pay before then and nothing changes for your students.`,
      'After that date the public website stops being served and changes are blocked. Your data is kept either way.',
    ],
    ctaLabel: 'Pay now',
  }),
  ar: defineLocale({
    subject: () => 'يبقى موقعك متاحًا 7 أيام إضافية',
    paragraphs: (v) => [
      `انتهت فترة اشتراكك في ${str(v, 'periodEndDate')} دون الموافقة على أي دفعة.`,
      `يبقى موقعك متاحًا ويستمر كل شيء بالعمل حتى ${str(v, 'graceEndsAtDate')}. ادفع قبل ذلك ولن يتغير شيء بالنسبة لطلابك.`,
      'بعد ذلك التاريخ يتوقف عرض الموقع العام وتُمنع التعديلات. بياناتك محفوظة في الحالتين.',
    ],
    ctaLabel: 'ادفع الآن',
  }),
};
