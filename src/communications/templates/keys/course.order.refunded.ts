import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * v2 (26 Sep 2026): Atlas takes payment by manual bank transfer and records
 * refunds without moving money, so this says the refund is RECORDED and the
 * amount is returned separately — never that the money has been refunded.
 */
export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Refund recorded',
    paragraphs: (v) => [
      `Your refund for "${str(v, 'courseTitle')}" has been recorded and your access to the course has ended.`,
      'The amount itself is returned to you separately by bank transfer, the same way you paid. Atlas does not move the money.',
    ],
    ctaLabel: 'View purchases',
  }),
  ar: defineLocale({
    subject: () => 'تم تسجيل الاسترداد',
    paragraphs: (v) => [
      `تم تسجيل استرداد قيمة "${str(v, 'courseTitle')}" وانتهى وصولك إلى الدورة.`,
      'يُعاد إليك المبلغ نفسه بشكل منفصل عبر تحويل بنكي، بالطريقة نفسها التي دفعت بها. لا تحوّل Atlas الأموال بنفسها.',
    ],
    ctaLabel: 'عرض المشتريات',
  }),
};
