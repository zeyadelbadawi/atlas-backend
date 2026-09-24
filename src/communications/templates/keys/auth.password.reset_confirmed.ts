import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your password was reset',
    paragraphs: (_v, ctx) => [
      `The password of your ${ctx.branding.platformName} account was reset and every other session was signed out.`,
      'If this was not you, contact support immediately.',
    ],
  }),
  ar: defineLocale({
    subject: () => 'تمت إعادة تعيين كلمة المرور',
    paragraphs: (_v, ctx) => [
      `تمت إعادة تعيين كلمة مرور حسابك في ${ctx.branding.platformName} وتم تسجيل الخروج من كل الجلسات الأخرى.`,
      'إذا لم تكن أنت من قام بذلك، تواصل مع الدعم فورًا.',
    ],
  }),
};
