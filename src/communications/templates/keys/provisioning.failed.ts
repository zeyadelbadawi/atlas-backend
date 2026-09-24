import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'We could not finish setting up your academy',
    paragraphs: (v) => [
      `We ran into a problem while provisioning "${str(v, 'academyName')}".`,
      'Our team has been notified. If this persists, please contact support from your dashboard.',
    ],
    ctaLabel: 'Open dashboard',
  }),
  ar: defineLocale({
    subject: () => 'تعذّر إكمال إعداد أكاديميتك',
    paragraphs: (v) => [
      `واجهنا مشكلة أثناء إعداد "${str(v, 'academyName')}".`,
      'تم إبلاغ فريقنا. إذا استمرت المشكلة، تواصل مع الدعم من لوحة التحكم.',
    ],
    ctaLabel: 'فتح لوحة التحكم',
  }),
};
