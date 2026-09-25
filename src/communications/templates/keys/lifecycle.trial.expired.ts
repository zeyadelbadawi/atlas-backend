import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T3 — consequential, and therefore not suppressible by preference:
 * their site is offline right now. The copy says exactly that and exactly
 * how to undo it, with no marketing around it.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your trial has ended and your site is offline',
    paragraphs: (v) => [
      `Your trial ended on ${str(v, 'endedAtDate')}. Your public website is no longer being served and changes are blocked.`,
      'Nothing has been deleted. Your academies, courses, students and files are exactly as you left them.',
      'Choosing a plan restores the site as soon as the payment is approved.',
    ],
    ctaLabel: 'Restore my site',
  }),
  ar: defineLocale({
    subject: () => 'انتهت فترتك التجريبية وتوقف عرض موقعك',
    paragraphs: (v) => [
      `انتهت فترتك التجريبية في ${str(v, 'endedAtDate')}. لم يعد موقعك العام معروضًا، والتعديلات ممنوعة.`,
      'لم يُحذف أي شيء. أكاديمياتك ودوراتك وطلابك وملفاتك كما تركتها تمامًا.',
      'اختيار خطة يعيد الموقع فور الموافقة على الدفع.',
    ],
    ctaLabel: 'إعادة تفعيل موقعي',
  }),
};
