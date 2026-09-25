import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** The 30-minute order window closed before payment (plan §8 D2). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your order for ${str(v, 'courseTitle', 'a course')} expired`,
    preheader: () => 'Nothing was charged. You can start a new order at any time.',
    paragraphs: (v) => [
      `The order you started for ${str(v, 'courseTitle', 'a course')} was not paid in time and has been released.`,
      'Nothing was charged. You can start a new order whenever you are ready.',
    ],
    ctaLabel: 'Start a new order',
  }),
  ar: defineLocale({
    subject: (v) => `انتهت صلاحية طلبك للدورة ${str(v, 'courseTitle', '')}`.trim(),
    preheader: () => 'لم يُخصم أي مبلغ. يمكنك بدء طلب جديد في أي وقت.',
    paragraphs: (v) => [
      `لم يتم دفع الطلب الذي بدأته لشراء ${str(v, 'courseTitle', 'دورة')} في الوقت المحدد، وقد تم إلغاؤه.`,
      'لم يُخصم أي مبلغ. يمكنك بدء طلب جديد متى شئت.',
    ],
    ctaLabel: 'بدء طلب جديد',
  }),
};
