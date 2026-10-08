/**
 * ATO review F3 — two-factor authentication was turned off for this
 * account, and every other signed-in session was ended. A security notice
 * with the signed-out recovery page as its way out.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Two-factor authentication was turned off',
    paragraphs: (_v, ctx) => [
      `Two-factor authentication is now off for your ${ctx.branding.platformName} account, and you were signed out on your other devices.`,
      'If this was you, no action is needed. If it was not, reset your password now and contact support.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تم إيقاف التحقق بخطوتين',
    paragraphs: (_v, ctx) => [
      `أصبح التحقق بخطوتين متوقفًا لحسابك في ${ctx.branding.platformName}، وتم تسجيل خروجك من أجهزتك الأخرى.`,
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
