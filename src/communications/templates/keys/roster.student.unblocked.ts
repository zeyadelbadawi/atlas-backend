import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** A suspension was lifted (plan §8 G3). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your access to ${str(v, 'academyName', 'the academy')} has been restored`,
    preheader: () => 'You can sign in and carry on where you left off.',
    paragraphs: (v) => [
      `${str(v, 'academyName', 'The academy')} has lifted the suspension on your account. You can sign in and carry on where you left off.`,
    ],
    ctaLabel: 'Open my courses',
  }),
  ar: defineLocale({
    subject: (v) => `تمت استعادة وصولك إلى ${str(v, 'academyName', 'الأكاديمية')}`,
    preheader: () => 'يمكنك تسجيل الدخول ومتابعة ما بدأته.',
    paragraphs: (v) => [
      `رفعت ${str(v, 'academyName', 'الأكاديمية')} الإيقاف عن حسابك. يمكنك تسجيل الدخول ومتابعة ما بدأته.`,
    ],
    ctaLabel: 'فتح دوراتي',
  }),
};
