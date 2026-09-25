import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * A pending self-registration was approved (plan §8 G2). Email is
 * `always`: the learner cannot enter the academy until this happens, so
 * an in-app row alone would be read only by someone who could not sign in.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your registration at ${str(v, 'academyName', 'the academy')} has been approved`,
    preheader: () => 'You can now sign in and start learning.',
    paragraphs: (v) => [
      `${str(v, 'academyName', 'The academy')} has approved your registration. You can sign in and start learning now.`,
    ],
    ctaLabel: 'Start learning',
  }),
  ar: defineLocale({
    subject: (v) => `تمت الموافقة على تسجيلك في ${str(v, 'academyName', 'الأكاديمية')}`,
    preheader: () => 'يمكنك الآن تسجيل الدخول وبدء التعلم.',
    paragraphs: (v) => [
      `وافقت ${str(v, 'academyName', 'الأكاديمية')} على تسجيلك. يمكنك تسجيل الدخول وبدء التعلم الآن.`,
    ],
    ctaLabel: 'ابدأ التعلم',
  }),
};
