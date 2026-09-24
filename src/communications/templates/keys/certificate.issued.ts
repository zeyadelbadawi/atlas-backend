import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your certificate is ready',
    paragraphs: (v) => [
      `Congratulations — your certificate for "${str(v, 'courseTitle')}" from ${str(v, 'academyName')} has been issued.`,
      `Verification code: ${str(v, 'verificationCode')}.`,
      'Download it from the Certificates section of your learning dashboard.',
    ],
    ctaLabel: 'View certificates',
  }),
  ar: defineLocale({
    subject: () => 'شهادتك جاهزة',
    paragraphs: (v) => [
      `تهانينا — صدرت شهادة إتمام دورة "${str(v, 'courseTitle')}" من ${str(v, 'academyName')}.`,
      `رقم التحقق: ${str(v, 'verificationCode')}.`,
      'يمكنك تنزيلها من قسم الشهادات في لوحة التعلم.',
    ],
    ctaLabel: 'عرض الشهادات',
  }),
};
