import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T6 — expiry + 45 days, the LAST commercial touch. After this the
 * sequence ends; there is no +60 d, +90 d or anniversary mail, because
 * every extra touch costs deliverability reputation for negligible
 * conversion.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Last note about your Atlas academy',
    paragraphs: (v) => [
      `Your trial ended on ${str(v, 'endedAtDate')}, and this is the last email we will send about it.`,
      'Your content is still stored and a plan restores it whenever you are ready. If now is not the time, nothing more is needed from you.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: () => 'آخر رسالة بخصوص أكاديميتك على أطلس',
    paragraphs: (v) => [
      `انتهت فترتك التجريبية في ${str(v, 'endedAtDate')}، وهذه آخر رسالة نرسلها بهذا الشأن.`,
      'محتواك ما زال محفوظًا، واختيار خطة يعيده متى شئت. وإن لم يكن الوقت مناسبًا الآن، فلا حاجة لأي إجراء منك.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
