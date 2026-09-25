import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T1 — the one email an owner expects when a trial begins. It states
 * the exact end date AND the consequence of doing nothing (the public
 * site goes offline at expiry), because that consequence is the whole
 * reason the later steps in this sequence exist.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your ${str(v, 'planName', 'Atlas')} trial has started`,
    paragraphs: (v) => [
      `Your trial of ${str(v, 'planName', 'Atlas')} is active until ${str(v, 'trialEndsAtDate')}.`,
      'Everything is unlocked until then: create academies, build courses and invite students.',
      'If no plan is chosen before that date, your public website goes offline and changes are blocked. Your data is kept — choosing a plan brings the site straight back.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: (v) => `بدأت فترتك التجريبية على ${str(v, 'planName', 'أطلس')}`,
    paragraphs: (v) => [
      `فترتك التجريبية على ${str(v, 'planName', 'أطلس')} فعّالة حتى ${str(v, 'trialEndsAtDate')}.`,
      'كل الميزات متاحة حتى ذلك التاريخ: أنشئ الأكاديميات وابنِ الدورات وادعُ الطلاب.',
      'إذا لم تختر خطة قبل ذلك التاريخ، سيتوقف عرض موقعك العام وستُمنع التعديلات. بياناتك محفوظة، واختيار خطة يعيد الموقع فورًا.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
