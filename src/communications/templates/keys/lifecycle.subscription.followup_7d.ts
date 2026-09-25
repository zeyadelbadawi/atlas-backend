import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §27 S10 (+7 d) — shorter and plainer than the trial follow-ups on
 * purpose: a paying customer already knows the product, so this is a
 * reminder that their site can come back, not a pitch.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your academy is still stored',
    paragraphs: (v) => [
      `Your subscription expired on ${str(v, 'expiredAtDate')} and your site has been offline for a week.`,
      'Everything is still stored exactly as it was. An approved payment puts the site and your students back online.',
    ],
    ctaLabel: 'Restore my site',
  }),
  ar: defineLocale({
    subject: () => 'أكاديميتك ما زالت محفوظة',
    paragraphs: (v) => [
      `انتهى اشتراكك في ${str(v, 'expiredAtDate')} وموقعك متوقف منذ أسبوع.`,
      'كل شيء ما زال محفوظًا كما هو تمامًا. الموافقة على دفعة تعيد الموقع وطلابك إلى الإنترنت.',
    ],
    ctaLabel: 'إعادة تفعيل موقعي',
  }),
};
