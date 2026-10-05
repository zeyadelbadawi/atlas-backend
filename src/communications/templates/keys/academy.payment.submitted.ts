import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { paymentMethodLabel } from '../payment-method-label';

/**
 * Academy Manual Payments — a learner submitted a payment proof to the
 * academy; the Client Owner must review it. `learnerName` is the learner's
 * own data (email body only — `personalValues`).
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New payment to review: ${str(v, 'courseTitle', 'a course')}`,
    preheader: () => 'A learner is waiting for your review.',
    paragraphs: (v) => [
      `${str(v, 'learnerName', 'A learner')} submitted a payment of ${str(v, 'amount')} ${str(v, 'currency')} by ${paymentMethodLabel('en', str(v, 'methodType'))} for "${str(v, 'courseTitle', 'a course')}".`,
      'Check that the money arrived, then approve or reject the payment. The learner gets access only after you approve it.',
    ],
    ctaLabel: 'Review payment',
  }),
  ar: defineLocale({
    subject: (v) => `دفعة جديدة للمراجعة: ${str(v, 'courseTitle', 'دورة')}`,
    preheader: () => 'متعلّم في انتظار مراجعتك.',
    paragraphs: (v) => [
      `أرسل ${str(v, 'learnerName', 'أحد المتعلّمين')} دفعة بقيمة ${str(v, 'amount')} ${str(v, 'currency')} عبر ${paymentMethodLabel('ar', str(v, 'methodType'))} لدورة "${str(v, 'courseTitle', 'دورة')}".`,
      'تأكّد من وصول المبلغ، ثم وافق على الدفعة أو ارفضها. لا يحصل المتعلّم على الوصول إلا بعد موافقتك.',
    ],
    ctaLabel: 'مراجعة الدفعة',
  }),
};
