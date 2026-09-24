import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Refund processed',
    paragraphs: (v) => [
      `Your purchase of "${str(v, 'courseTitle')}" has been refunded.`,
      'Depending on your payment method it may take a few days for the amount to appear.',
    ],
    ctaLabel: 'View purchases',
  }),
  ar: defineLocale({
    subject: () => 'تمت معالجة الاسترداد',
    paragraphs: (v) => [
      `تم استرداد قيمة شراء "${str(v, 'courseTitle')}".`,
      'قد يستغرق ظهور المبلغ بضعة أيام حسب وسيلة الدفع.',
    ],
    ctaLabel: 'عرض المشتريات',
  }),
};
