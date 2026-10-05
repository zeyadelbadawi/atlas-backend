import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { paymentMethodLabel } from '../payment-method-label';

/**
 * Academy Manual Payments — the Client Owner rejected the learner's payment.
 * The reason is the owner's own text, optional; the layout escapes it.
 * Sent exactly once per payment (dedupe on the payment id). The learner may
 * submit a new payment for the same order.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Payment not approved: ${str(v, 'courseTitle', 'your course')}`,
    preheader: () => 'You can submit a new payment.',
    paragraphs: (v) => {
      const lines = [
        `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} for "${str(v, 'courseTitle', 'your course')}" (${paymentMethodLabel('en', str(v, 'methodType'))}) was not approved.`,
      ];
      const reason = str(v, 'reason');
      lines.push(reason ? `Reason: ${reason}` : 'No reason was given.');
      lines.push(
        'You do not have access to the course yet. You can submit a new payment from My payments.',
      );
      return lines;
    },
    ctaLabel: 'Open my payments',
  }),
  ar: defineLocale({
    subject: (v) => `لم تتم الموافقة على الدفع: ${str(v, 'courseTitle', 'دورتك')}`,
    preheader: () => 'يمكنك إرسال دفعة جديدة.',
    paragraphs: (v) => {
      const lines = [
        `لم تتم الموافقة على دفعتك بقيمة ${str(v, 'amount')} ${str(v, 'currency')} لدورة "${str(v, 'courseTitle', 'دورتك')}" (${paymentMethodLabel('ar', str(v, 'methodType'))}).`,
      ];
      const reason = str(v, 'reason');
      lines.push(reason ? `السبب: ${reason}` : 'لم يُذكر سبب.');
      lines.push(
        'لا يمكنك الوصول إلى الدورة بعد. يمكنك إرسال دفعة جديدة من صفحة مدفوعاتي.',
      );
      return lines;
    },
    ctaLabel: 'فتح مدفوعاتي',
  }),
};
