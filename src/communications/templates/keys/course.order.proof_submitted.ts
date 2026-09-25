import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Receipt for a manual payment proof (plan §8 D3, §10 "always (receipt)
 * to learner"). It promises a REVIEW, never an outcome — the approval and
 * rejection emails are separate catalogue keys.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'We received your payment proof',
    preheader: () => 'It is now waiting to be reviewed.',
    paragraphs: (v) => {
      const lines = [
        `We have received the payment proof you uploaded for ${str(v, 'courseTitle', 'your course')}. It is now waiting to be reviewed.`,
      ];
      const amount = str(v, 'amount');
      if (amount) {
        lines.push(`Amount submitted: ${amount} ${str(v, 'currency')}`.trim());
      }
      lines.push(
        'You will receive another email as soon as the review is done. Nothing else is needed from you right now.',
      );
      return lines;
    },
    ctaLabel: 'View my purchases',
  }),
  ar: defineLocale({
    subject: () => 'استلمنا إثبات الدفع الخاص بك',
    preheader: () => 'أصبح الآن في انتظار المراجعة.',
    paragraphs: (v) => {
      const lines = [
        `استلمنا إثبات الدفع الذي رفعته من أجل ${str(v, 'courseTitle', 'دورتك')}، وهو الآن في انتظار المراجعة.`,
      ];
      const amount = str(v, 'amount');
      if (amount) {
        lines.push(`المبلغ المُرسَل: ${amount} ${str(v, 'currency')}`.trim());
      }
      lines.push(
        'سنرسل إليك رسالة أخرى فور انتهاء المراجعة. لا حاجة لأي إجراء منك الآن.',
      );
      return lines;
    },
    ctaLabel: 'عرض مشترياتي',
  }),
};
