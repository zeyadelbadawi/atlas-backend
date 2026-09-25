import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** §27 S10 (+30 d) — the last touch of the paid sequence. Nothing follows it. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Last note about your Atlas subscription',
    paragraphs: (v) => [
      `Your subscription expired on ${str(v, 'expiredAtDate')}, and this is the last email we will send about it.`,
      'Your content is still stored and a plan restores it whenever you are ready.',
    ],
    ctaLabel: 'Restore my site',
  }),
  ar: defineLocale({
    subject: () => 'آخر رسالة بخصوص اشتراكك في أطلس',
    paragraphs: (v) => [
      `انتهى اشتراكك في ${str(v, 'expiredAtDate')}، وهذه آخر رسالة نرسلها بهذا الشأن.`,
      'محتواك ما زال محفوظًا، واختيار خطة يعيده متى شئت.',
    ],
    ctaLabel: 'إعادة تفعيل موقعي',
  }),
};
