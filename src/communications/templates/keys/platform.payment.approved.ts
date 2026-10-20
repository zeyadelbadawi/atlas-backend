import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * v2 (20 Oct 2026) — no invoices are issued (the `TenantInvoice` table has
 * no writer, and billing offers no Invoices page), so the email points at
 * the payment history instead of promising invoices there. The
 * subscription receipt itself is `lifecycle.subscription.activated`.
 */
export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Payment approved',
    paragraphs: (v) => [
      `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} has been approved.`,
      'Your subscription is up to date. You can see this payment in your payment history in billing.',
    ],
    ctaLabel: 'Open billing',
  }),
  ar: defineLocale({
    subject: () => 'تمت الموافقة على الدفع',
    paragraphs: (v) => [
      `تمت الموافقة على دفعتك بقيمة ${str(v, 'amount')} ${str(v, 'currency')}.`,
      'اشتراكك محدّث. يمكنك الاطّلاع على هذه الدفعة في سجل المدفوعات في صفحة الفوترة.',
    ],
    ctaLabel: 'فتح الفوترة',
  }),
};
