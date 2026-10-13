import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 S3a — yearly subscriptions only, 30 days out. A year's renewal
 * by bank or wallet transfer is a larger payment that often needs someone
 * else's approval; the 7-day (S3) and 1-day (S4) reminders still follow.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your yearly plan renews in 30 days',
    paragraphs: (v) => [
      `Your ${str(v, 'planName', 'Atlas')} yearly period ends on ${str(v, 'periodEndDate')}.`,
      'Payments are reviewed by a person and transfers can take a few working days. A month gives you time to arrange the payment before the period ends.',
      'We will remind you again 7 days and 1 day before the period ends.',
    ],
    ctaLabel: 'Renew now',
  }),
  ar: defineLocale({
    subject: () => 'يُجدَّد اشتراكك السنوي خلال 30 يومًا',
    paragraphs: (v) => [
      `تنتهي الفترة السنوية لخطتك ${str(v, 'planName', 'أطلس')} في ${str(v, 'periodEndDate')}.`,
      'تتم مراجعة المدفوعات بواسطة موظف وقد تستغرق التحويلات أيام عمل. يمنحك الشهر وقتًا لترتيب الدفع قبل انتهاء الفترة.',
      'سنذكّرك مرة أخرى قبل انتهاء الفترة بـ 7 أيام وبيوم واحد.',
    ],
    ctaLabel: 'تجديد الآن',
  }),
};
