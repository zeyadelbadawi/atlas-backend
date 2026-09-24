import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your academy is ready',
    preheader: (v) => `${str(v, 'academyName')} has finished setting up.`,
    paragraphs: (v) => [
      `"${str(v, 'academyName')}" has finished provisioning and is ready to use.`,
      'Open your dashboard to add courses, invite your team and publish your website.',
    ],
    ctaLabel: 'Open dashboard',
  }),
  ar: defineLocale({
    subject: () => 'أكاديميتك جاهزة',
    preheader: (v) => `اكتمل إعداد ${str(v, 'academyName')}.`,
    paragraphs: (v) => [
      `اكتمل إعداد "${str(v, 'academyName')}" وهي جاهزة للاستخدام.`,
      'افتح لوحة التحكم لإضافة الدورات ودعوة فريقك ونشر موقعك.',
    ],
    ctaLabel: 'فتح لوحة التحكم',
  }),
};
