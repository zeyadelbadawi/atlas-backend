import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { paymentMethodLabel } from '../payment-method-label';

/**
 * B0-SUP-01 — a learner submitted a proof for a course payment that Atlas
 * collects. Platform Owners only. The learner's identity stays on the
 * payment; the call to action opens it in the course payment queue.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Course payment to review: ${str(v, 'courseTitle', 'a course')}`,
    preheader: () => 'A course payment proof is waiting for review.',
    paragraphs: (v) => [
      `A learner at ${str(v, 'academyName', 'an academy')} submitted a payment of ${str(v, 'amount')} ${str(v, 'currency')} by ${paymentMethodLabel('en', str(v, 'methodType'))} for "${str(v, 'courseTitle', 'a course')}".`,
      'Check that the money arrived, then approve or reject the payment. The learner gets access only after it is approved.',
    ],
    ctaLabel: 'Review payment',
  }),
  ar: defineLocale({
    subject: (v) => `دفعة دورة للمراجعة: ${str(v, 'courseTitle', 'دورة')}`,
    preheader: () => 'إثبات دفع لدورة في انتظار المراجعة.',
    paragraphs: (v) => [
      `أرسل متعلّم في ${str(v, 'academyName', 'إحدى الأكاديميات')} دفعة بقيمة ${str(v, 'amount')} ${str(v, 'currency')} عبر ${paymentMethodLabel('ar', str(v, 'methodType'))} لدورة "${str(v, 'courseTitle', 'دورة')}".`,
      'تأكّد من وصول المبلغ، ثم وافق على الدفعة أو ارفضها. لا يحصل المتعلّم على الوصول إلا بعد الموافقة.',
    ],
    ctaLabel: 'مراجعة الدفعة',
  }),
};
