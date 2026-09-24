import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Payment failed',
    paragraphs: (v) => [
      `Your payment for "${str(v, 'courseTitle')}" could not be completed.`,
      'Please try again or use a different payment method. Your order is kept under your purchases.',
    ],
    ctaLabel: 'View purchases',
  }),
  ar: defineLocale({
    subject: () => 'فشل الدفع',
    paragraphs: (v) => [
      `تعذّر إتمام الدفع لدورة "${str(v, 'courseTitle')}".`,
      'حاول مرة أخرى أو استخدم وسيلة دفع مختلفة. يبقى طلبك محفوظًا في صفحة مشترياتك.',
    ],
    ctaLabel: 'عرض المشتريات',
  }),
};
