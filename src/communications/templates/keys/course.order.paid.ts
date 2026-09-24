import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Purchase confirmed',
    preheader: (v) => `You now have access to ${str(v, 'courseTitle')}.`,
    paragraphs: (v) => [
      `Your purchase of "${str(v, 'courseTitle')}" is confirmed. You now have access to the course.`,
      'You can find this order and its receipt under your purchases at any time.',
    ],
    ctaLabel: 'View purchases',
  }),
  ar: defineLocale({
    subject: () => 'تم تأكيد الشراء',
    preheader: (v) => `أصبح بإمكانك الوصول إلى ${str(v, 'courseTitle')}.`,
    paragraphs: (v) => [
      `تم تأكيد شراء "${str(v, 'courseTitle')}"، ويمكنك الآن الوصول إلى الدورة.`,
      'يمكنك العثور على هذا الطلب وإيصاله في صفحة مشترياتك في أي وقت.',
    ],
    ctaLabel: 'عرض المشتريات',
  }),
};
