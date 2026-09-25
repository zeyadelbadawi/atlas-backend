import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** A device was removed from the learner's registry (plan §8 B2). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Device removed: ${str(v, 'deviceLabel', 'a device')}`,
    preheader: () => 'It has been signed out and can no longer play lessons.',
    paragraphs: (v) => [
      `${str(v, 'deviceLabel', 'A device')} was removed from your devices. It has been signed out and can no longer play lessons.`,
      'If this was not you, change your password and review the devices still on your account.',
    ],
    ctaLabel: 'Manage devices',
  }),
  ar: defineLocale({
    subject: (v) => `تم حذف جهاز: ${str(v, 'deviceLabel', 'أحد الأجهزة')}`,
    preheader: () => 'تم تسجيل خروجه ولم يعد بإمكانه تشغيل الدروس.',
    paragraphs: (v) => [
      `تم حذف ${str(v, 'deviceLabel', 'أحد الأجهزة')} من قائمة أجهزتك. تم تسجيل خروجه ولم يعد بإمكانه تشغيل الدروس.`,
      'إذا لم تكن أنت من قام بذلك، فغيّر كلمة المرور وراجع الأجهزة المتبقية على حسابك.',
    ],
    ctaLabel: 'إدارة الأجهزة',
  }),
};
