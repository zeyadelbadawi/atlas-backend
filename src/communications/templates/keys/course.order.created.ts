import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * An order was opened for a paid course (plan §8 D1). In-app only — §10
 * puts the receipt on D3 (`course.order.proof_submitted`), so this one
 * exists to give the learner a feed row they can return to, not a mail.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your order for ${str(v, 'courseTitle', 'a course')}`,
    preheader: () => 'Complete the payment to finish enrolling.',
    paragraphs: (v) => {
      const lines = [
        `You started an order for ${str(v, 'courseTitle', 'a course')} (${str(v, 'amount', '—')} ${str(v, 'currency', '')}).`.trim(),
      ];
      const minutes = str(v, 'expiresInMinutes');
      lines.push(
        minutes
          ? `Complete the payment within ${minutes} minutes, or the order is released and you can start a new one.`
          : 'Complete the payment to finish enrolling.',
      );
      return lines;
    },
    ctaLabel: 'Open the order',
  }),
  ar: defineLocale({
    subject: (v) => `طلبك للدورة ${str(v, 'courseTitle', '')}`.trim(),
    preheader: () => 'أكمل الدفع لإتمام التسجيل.',
    paragraphs: (v) => {
      const lines = [
        `لقد بدأت طلبًا لشراء ${str(v, 'courseTitle', 'دورة')} بقيمة ${str(v, 'amount', '—')} ${str(v, 'currency', '')}.`.trim(),
      ];
      const minutes = str(v, 'expiresInMinutes');
      lines.push(
        minutes
          ? `أكمل الدفع خلال ${minutes} دقيقة، وإلا فسيُلغى الطلب ويمكنك بدء طلب جديد.`
          : 'أكمل الدفع لإتمام التسجيل.',
      );
      return lines;
    },
    ctaLabel: 'فتح الطلب',
  }),
};
