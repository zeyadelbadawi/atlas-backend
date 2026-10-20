import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * v2 (20 Oct 2026) — there is no receipt document under the learner's
 * purchases (the page lists orders only), so this email no longer points
 * at one: the email itself is the purchase confirmation.
 */
export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Purchase confirmed',
    preheader: (v) => `You now have access to ${str(v, 'courseTitle')}.`,
    paragraphs: (v) => [
      `Your purchase of "${str(v, 'courseTitle')}" is confirmed. You now have access to the course.`,
      'Keep this email as your purchase confirmation. You can find the order under your purchases at any time.',
    ],
    ctaLabel: 'View purchases',
  }),
  ar: defineLocale({
    subject: () => 'تم تأكيد الشراء',
    preheader: (v) => `أصبح بإمكانك الوصول إلى ${str(v, 'courseTitle')}.`,
    paragraphs: (v) => [
      `تم تأكيد شراء "${str(v, 'courseTitle')}"، ويمكنك الآن الوصول إلى الدورة.`,
      'احتفظ بهذه الرسالة لتأكيد الشراء. يمكنك العثور على الطلب في صفحة مشترياتك في أي وقت.',
    ],
    ctaLabel: 'عرض المشتريات',
  }),
};
