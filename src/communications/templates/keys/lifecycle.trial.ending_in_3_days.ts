import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 T2a — three days ahead, sent only when the trial is at least a
 * week long. Payment is a manual transfer that a person reviews, so the
 * one-day reminder (T2) alone leaves too little time on a 14-day trial.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your trial ends in 3 days',
    paragraphs: (v) => [
      `Your ${str(v, 'planName', 'Atlas')} trial ends on ${str(v, 'trialEndsAtDate')}.`,
      'Payments are reviewed by a person and transfers can take a working day or two, so choosing a plan now keeps your site online without a gap.',
      'If the trial ends first, your public website goes offline and changes are blocked until a plan is active. Nothing is deleted.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: () => 'تنتهي فترتك التجريبية خلال 3 أيام',
    paragraphs: (v) => [
      `تنتهي الفترة التجريبية لخطتك ${str(v, 'planName', 'أطلس')} في ${str(v, 'trialEndsAtDate')}.`,
      'تتم مراجعة المدفوعات بواسطة موظف وقد تستغرق التحويلات يوم عمل أو يومين، لذا فإن اختيار خطة الآن يبقي موقعك متاحًا دون انقطاع.',
      'إذا انتهت الفترة التجريبية أولًا، سيتوقف عرض موقعك العام وستُمنع التعديلات حتى تُفعَّل خطة. لن يُحذف أي شيء.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
