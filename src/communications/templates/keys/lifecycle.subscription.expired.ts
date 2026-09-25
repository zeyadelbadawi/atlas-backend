import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** §27 S7 — access has actually ended. Not suppressible, same reason as T3. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your subscription has expired and your site is offline',
    paragraphs: (v) => [
      `Your grace period ended on ${str(v, 'graceEndsAtDate')}. Your public website is no longer being served and changes are blocked.`,
      'Nothing has been deleted. Your academies, courses, students and files are all still stored.',
      'An approved payment restores the site straight away.',
    ],
    ctaLabel: 'Restore my site',
  }),
  ar: defineLocale({
    subject: () => 'انتهى اشتراكك وتوقف عرض موقعك',
    paragraphs: (v) => [
      `انتهت مهلة السماح في ${str(v, 'graceEndsAtDate')}. لم يعد موقعك العام معروضًا، والتعديلات ممنوعة.`,
      'لم يُحذف أي شيء. أكاديمياتك ودوراتك وطلابك وملفاتك ما زالت محفوظة.',
      'الموافقة على دفعة تعيد الموقع فورًا.',
    ],
    ctaLabel: 'إعادة تفعيل موقعي',
  }),
};
