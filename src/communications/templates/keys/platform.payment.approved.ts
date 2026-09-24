import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Payment approved',
    paragraphs: (v) => [
      `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} has been approved.`,
      'Your subscription is up to date. You can review invoices and payments in billing.',
    ],
    ctaLabel: 'Open billing',
  }),
  ar: defineLocale({
    subject: () => 'تمت الموافقة على الدفع',
    paragraphs: (v) => [
      `تمت الموافقة على دفعتك بقيمة ${str(v, 'amount')} ${str(v, 'currency')}.`,
      'اشتراكك محدّث. يمكنك مراجعة الفواتير والمدفوعات في صفحة الفوترة.',
    ],
    ctaLabel: 'فتح الفوترة',
  }),
};
