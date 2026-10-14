import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SUP-01 — a refund was recorded on a course payment Atlas collected.
 * Platform Owners only. Recording it moves no money: the payment is
 * returned outside the platform, which is why Atlas is told.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Refund recorded: ${str(v, 'courseTitle', 'a course')}`,
    preheader: () => 'A course refund needs the money returned.',
    paragraphs: (v) => [
      `A refund of ${str(v, 'amount')} ${str(v, 'currency')} was recorded for "${str(v, 'courseTitle', 'a course')}" at ${str(v, 'academyName', 'an academy')}.`,
      'Atlas collected this payment. Return the money to the learner outside the platform.',
    ],
    ctaLabel: 'View payment',
  }),
  ar: defineLocale({
    subject: (v) => `تم تسجيل استرداد: ${str(v, 'courseTitle', 'دورة')}`,
    preheader: () => 'استرداد دورة يحتاج إلى إعادة المبلغ.',
    paragraphs: (v) => [
      `تم تسجيل استرداد بقيمة ${str(v, 'amount')} ${str(v, 'currency')} لدورة "${str(v, 'courseTitle', 'دورة')}" في ${str(v, 'academyName', 'إحدى الأكاديميات')}.`,
      'حصّلت Atlas هذه الدفعة. أعِد المبلغ إلى المتعلّم خارج المنصة.',
    ],
    ctaLabel: 'عرض الدفعة',
  }),
};
