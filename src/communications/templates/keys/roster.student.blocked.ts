import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Academy staff suspended a learner's membership (plan §8 G3). Sessions,
 * learning leases and video-gate grants are dropped in the same request,
 * so the learner is signed out mid-lesson — being told why is the whole
 * point of `always`.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your access to ${str(v, 'academyName', 'the academy')} has been suspended`,
    paragraphs: (v) => [
      `${str(v, 'academyName', 'The academy')} has suspended your access. You have been signed out and cannot open its courses until the suspension is lifted.`,
      'Your enrollments, progress and results are kept. Contact the academy if you need this reviewed.',
    ],
  }),
  ar: defineLocale({
    subject: (v) => `تم إيقاف وصولك إلى ${str(v, 'academyName', 'الأكاديمية')}`,
    paragraphs: (v) => [
      `أوقفت ${str(v, 'academyName', 'الأكاديمية')} وصولك. تم تسجيل خروجك ولا يمكنك فتح دوراتها حتى يُرفع الإيقاف.`,
      'تبقى تسجيلاتك وتقدمك ونتائجك محفوظة. يرجى التواصل مع الأكاديمية إذا أردت مراجعة القرار.',
    ],
  }),
};
