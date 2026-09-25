import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T4 — expiry + 3 days: long enough not to feel like nagging, short
 * enough that the evaluation is still fresh. Sent only when no plan was
 * chosen and no cancellation was recorded.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your Atlas work is still here',
    paragraphs: (v) => [
      `Your trial ended on ${str(v, 'endedAtDate')} and your site is currently offline.`,
      'Everything you built is still stored and untouched. Choosing a plan puts it back online — you do not have to rebuild anything.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: () => 'عملك على أطلس ما زال محفوظًا',
    paragraphs: (v) => [
      `انتهت فترتك التجريبية في ${str(v, 'endedAtDate')}، وموقعك متوقف حاليًا.`,
      'كل ما أنشأته ما زال محفوظًا دون تغيير. اختيار خطة يعيده إلى الإنترنت، ولا حاجة لإعادة بناء أي شيء.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
