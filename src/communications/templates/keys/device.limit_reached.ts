import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Content was refused because the learner is at their device cap (plan
 * §8 B3). In-app only by §10 — the learner is in front of the player,
 * which already explains it; this is the record they can act on later.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'You have reached your device limit',
    preheader: () => 'Remove a device to carry on learning here.',
    paragraphs: (v) => {
      const max = str(v, 'maxDevices');
      return [
        `This academy allows ${max || 'a limited number of'} device${max === '1' ? '' : 's'} per learner, and this browser is over that limit, so the lesson could not be opened.`,
        'Remove a device you no longer use and open the lesson again.',
      ];
    },
    ctaLabel: 'Manage devices',
  }),
  ar: defineLocale({
    subject: () => 'لقد بلغت الحد الأقصى لعدد الأجهزة',
    preheader: () => 'احذف أحد الأجهزة لمتابعة التعلم هنا.',
    paragraphs: (v) => {
      const max = str(v, 'maxDevices');
      return [
        `تسمح هذه الأكاديمية بعدد ${max || 'محدود من'} من الأجهزة لكل متعلم، وهذا المتصفح يتجاوز ذلك الحد، لذلك تعذّر فتح الدرس.`,
        'احذف جهازًا لم تعد تستخدمه ثم افتح الدرس مرة أخرى.',
      ];
    },
    ctaLabel: 'إدارة الأجهزة',
  }),
};
