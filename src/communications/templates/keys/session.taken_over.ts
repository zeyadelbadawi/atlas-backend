import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** The single learning session moved to another device (plan §8 B4). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your learning session moved to another device',
    preheader: () => 'The other device was signed out of the player.',
    paragraphs: (v) => {
      const previous = str(v, 'previousDeviceLabel');
      return [
        `Learning moved to ${str(v, 'deviceLabel', 'another device')}.${previous ? ` ${previous} was signed out of the player.` : ''}`,
        'Only one device can play lessons at a time. If this was not you, remove the device and change your password.',
      ];
    },
    ctaLabel: 'Manage devices',
  }),
  ar: defineLocale({
    subject: () => 'انتقلت جلسة التعلم إلى جهاز آخر',
    preheader: () => 'تم إخراج الجهاز الآخر من المشغّل.',
    paragraphs: (v) => {
      const previous = str(v, 'previousDeviceLabel');
      return [
        `انتقل التعلم إلى ${str(v, 'deviceLabel', 'جهاز آخر')}.${previous ? ` تم إخراج ${previous} من المشغّل.` : ''}`,
        'يمكن لجهاز واحد فقط تشغيل الدروس في الوقت نفسه. إذا لم تكن أنت، فاحذف الجهاز وغيّر كلمة المرور.',
      ];
    },
    ctaLabel: 'إدارة الأجهزة',
  }),
};
