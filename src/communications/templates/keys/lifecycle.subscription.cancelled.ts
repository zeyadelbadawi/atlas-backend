import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** §27 S9 — the cancellation took effect; the site is now offline. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your subscription has ended',
    paragraphs: (v) => [
      `Your subscription ended on ${str(v, 'effectiveAtDate')}, as you asked. Your public website is no longer being served and changes are blocked.`,
      'Your data is kept. If you come back, a new plan restores the site with everything as you left it.',
      'Thank you for the time you spent with us.',
    ],
    ctaLabel: 'View subscription',
  }),
  ar: defineLocale({
    subject: () => 'انتهى اشتراكك',
    paragraphs: (v) => [
      `انتهى اشتراكك في ${str(v, 'effectiveAtDate')} بناءً على طلبك. لم يعد موقعك العام معروضًا، والتعديلات ممنوعة.`,
      'بياناتك محفوظة. وإذا عدت، فإن خطة جديدة تعيد الموقع بكل ما تركته فيه.',
      'شكرًا للوقت الذي قضيته معنا.',
    ],
    ctaLabel: 'عرض الاشتراك',
  }),
};
