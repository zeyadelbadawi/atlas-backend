import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §27 S3 — seven days out, and not suppressible. Renewal here is a manual
 * bank or wallet transfer reviewed by a person: a reminder that arrives
 * after the period ended cannot be acted on in time, which is precisely
 * why this one ignores the reminders toggle.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your subscription renews in 7 days',
    paragraphs: (v) => [
      `Your ${str(v, 'planName', 'Atlas')} period ends on ${str(v, 'periodEndDate')}.`,
      'Payments are reviewed by a person and transfers can take a few working days, so starting now is what keeps everything running without interruption.',
      'If the period ends before a payment is approved, your site stays online for 7 more days before access stops.',
    ],
    ctaLabel: 'Renew now',
  }),
  ar: defineLocale({
    subject: () => 'يُجدَّد اشتراكك خلال 7 أيام',
    paragraphs: (v) => [
      `تنتهي فترة خطتك ${str(v, 'planName', 'أطلس')} في ${str(v, 'periodEndDate')}.`,
      'تتم مراجعة المدفوعات بواسطة موظف وقد تستغرق التحويلات أيام عمل، لذا فإن البدء الآن هو ما يضمن استمرار كل شيء دون انقطاع.',
      'إذا انتهت الفترة قبل الموافقة على الدفع، سيبقى موقعك متاحًا 7 أيام إضافية قبل أن يتوقف الوصول.',
    ],
    ctaLabel: 'تجديد الآن',
  }),
};
