import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SUP-01 — an organization submitted a subscription payment proof.
 * Addressed to Platform Owners only; the call to action opens the payment
 * in the subscription review queue.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Subscription payment to review: ${str(v, 'organizationName', 'an organization')}`,
    preheader: () => 'A payment proof is waiting for review.',
    paragraphs: (v) => [
      `${str(v, 'organizationName', 'An organization')} submitted a payment proof of ${str(v, 'amount')} ${str(v, 'currency')} for its subscription.`,
      'Check that the money arrived, then approve or reject the payment.',
    ],
    ctaLabel: 'Review payment',
  }),
  ar: defineLocale({
    subject: (v) => `دفعة اشتراك للمراجعة: ${str(v, 'organizationName', 'مؤسسة')}`,
    preheader: () => 'إثبات دفع في انتظار المراجعة.',
    paragraphs: (v) => [
      `أرسلت ${str(v, 'organizationName', 'إحدى المؤسسات')} إثبات دفع بقيمة ${str(v, 'amount')} ${str(v, 'currency')} لاشتراكها.`,
      'تأكّد من وصول المبلغ، ثم وافق على الدفعة أو ارفضها.',
    ],
    ctaLabel: 'مراجعة الدفعة',
  }),
};
