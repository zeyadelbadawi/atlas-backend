import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Payment rejected',
    paragraphs: (v) => [
      `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} was rejected.${
        str(v, 'reason') ? ` Reason: ${str(v, 'reason')}` : ''
      }`,
      'Please submit a new payment from billing so your subscription stays active.',
    ],
    ctaLabel: 'Open billing',
  }),
  ar: defineLocale({
    subject: () => 'تم رفض الدفع',
    paragraphs: (v) => [
      `تم رفض دفعتك بقيمة ${str(v, 'amount')} ${str(v, 'currency')}.${
        str(v, 'reason') ? ` السبب: ${str(v, 'reason')}` : ''
      }`,
      'يرجى إرسال دفعة جديدة من صفحة الفوترة ليبقى اشتراكك نشطًا.',
    ],
    ctaLabel: 'فتح الفوترة',
  }),
};
