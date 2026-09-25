import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** §27 S4 — one day out, and only while the period is genuinely still unpaid. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your subscription period ends tomorrow',
    paragraphs: (v) => [
      `Your ${str(v, 'planName', 'Atlas')} period ends on ${str(v, 'periodEndDate')} and no payment has been approved yet.`,
      'Your site will not go offline that day: a 7-day grace period follows, during which everything keeps working while your transfer is reviewed.',
    ],
    ctaLabel: 'Renew now',
  }),
  ar: defineLocale({
    subject: () => 'تنتهي فترة اشتراكك غدًا',
    paragraphs: (v) => [
      `تنتهي فترة خطتك ${str(v, 'planName', 'أطلس')} في ${str(v, 'periodEndDate')} ولم تتم الموافقة على أي دفعة بعد.`,
      'لن يتوقف موقعك في ذلك اليوم: تليه مهلة سماح مدتها 7 أيام يستمر خلالها كل شيء بالعمل أثناء مراجعة تحويلك.',
    ],
    ctaLabel: 'تجديد الآن',
  }),
};
