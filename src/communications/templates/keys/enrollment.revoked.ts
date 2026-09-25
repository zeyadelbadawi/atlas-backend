import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Course access ended by academy staff (plan §8 C3). Plain and
 * non-accusatory on purpose (§10): the learner is told what changed and
 * where to ask, not why someone decided it.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your access to ${str(v, 'courseTitle', 'a course')} has ended`,
    preheader: () => 'This course is no longer available in your account.',
    paragraphs: (v) => [
      `${str(v, 'academyName', 'Your academy')} has ended your access to ${str(v, 'courseTitle', 'a course')}. It is no longer available in your account.`,
      'Your progress and results are kept. If you think this is a mistake, contact the academy.',
    ],
    ctaLabel: 'Open my courses',
  }),
  ar: defineLocale({
    subject: (v) => `انتهى وصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')}`,
    preheader: () => 'لم تعد هذه الدورة متاحة في حسابك.',
    paragraphs: (v) => [
      `أنهت ${str(v, 'academyName', 'أكاديميتك')} وصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')}، ولم تعد متاحة في حسابك.`,
      'يبقى تقدمك ونتائجك محفوظة. إذا كنت ترى أن هذا خطأ، يرجى التواصل مع الأكاديمية.',
    ],
    ctaLabel: 'فتح دوراتي',
  }),
};
