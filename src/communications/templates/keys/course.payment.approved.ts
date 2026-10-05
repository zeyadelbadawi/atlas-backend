import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { paymentMethodLabel } from '../payment-method-label';

/**
 * Academy Manual Payments — the Client Owner approved the learner's payment
 * to the academy. Sent exactly once per payment (dedupe on the payment id):
 * a payment is approved once, by the conditional review claim.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Payment approved: ${str(v, 'courseTitle', 'your course')}`,
    preheader: () => 'Your course is ready.',
    paragraphs: (v) => [
      `Your payment for "${str(v, 'courseTitle', 'your course')}" has been approved, and you now have access to the course.`,
      `Amount: ${str(v, 'amount')} ${str(v, 'currency')}. Method: ${paymentMethodLabel('en', str(v, 'methodType'))}.`,
      'You can find this payment under My payments at any time.',
    ],
    ctaLabel: 'View my payments',
  }),
  ar: defineLocale({
    subject: (v) => `تمت الموافقة على الدفع: ${str(v, 'courseTitle', 'دورتك')}`,
    preheader: () => 'دورتك جاهزة.',
    paragraphs: (v) => [
      `تمت الموافقة على دفعتك لدورة "${str(v, 'courseTitle', 'دورتك')}"، ويمكنك الآن الوصول إلى الدورة.`,
      `المبلغ: ${str(v, 'amount')} ${str(v, 'currency')}. وسيلة الدفع: ${paymentMethodLabel('ar', str(v, 'methodType'))}.`,
      'يمكنك العثور على هذه الدفعة في صفحة مدفوعاتي في أي وقت.',
    ],
    ctaLabel: 'عرض مدفوعاتي',
  }),
};
