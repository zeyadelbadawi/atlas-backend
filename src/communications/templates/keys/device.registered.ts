import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** A new browser was added to the learner's device list (plan §8 B1). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New device added: ${str(v, 'deviceLabel', 'a new browser')}`,
    preheader: () => 'If this was not you, remove it from your devices.',
    paragraphs: (v) => [
      `${str(v, 'deviceLabel', 'A new browser')} was added to the devices you use for learning.`,
      'If this was not you, remove it from your devices and change your password.',
    ],
    ctaLabel: 'Manage devices',
  }),
  ar: defineLocale({
    subject: (v) => `تمت إضافة جهاز جديد: ${str(v, 'deviceLabel', 'متصفح جديد')}`,
    preheader: () => 'إذا لم تكن أنت، فاحذفه من قائمة أجهزتك.',
    paragraphs: (v) => [
      `تمت إضافة ${str(v, 'deviceLabel', 'متصفح جديد')} إلى قائمة الأجهزة التي تستخدمها للتعلم.`,
      'إذا لم تكن أنت من قام بذلك، فاحذف الجهاز من قائمة أجهزتك وغيّر كلمة المرور.',
    ],
    ctaLabel: 'إدارة الأجهزة',
  }),
};
