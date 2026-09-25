import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * A pending self-registration was not approved (plan §8 G2). §10 asks for
 * plain, non-accusatory copy: it states the outcome and the one useful
 * next step, and gives no reason the academy did not write.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your registration at ${str(v, 'academyName', 'the academy')} was not approved`,
    paragraphs: (v) => [
      `${str(v, 'academyName', 'The academy')} has reviewed your registration and did not approve it, so your account has no access to its courses.`,
      'If you believe this is a mistake, contact the academy directly.',
    ],
  }),
  ar: defineLocale({
    subject: (v) =>
      `لم تتم الموافقة على تسجيلك في ${str(v, 'academyName', 'الأكاديمية')}`,
    paragraphs: (v) => [
      `راجعت ${str(v, 'academyName', 'الأكاديمية')} طلب تسجيلك ولم توافق عليه، لذلك لا يملك حسابك وصولًا إلى دوراتها.`,
      'إذا كنت ترى أن هذا خطأ، يرجى التواصل مع الأكاديمية مباشرة.',
    ],
  }),
};
