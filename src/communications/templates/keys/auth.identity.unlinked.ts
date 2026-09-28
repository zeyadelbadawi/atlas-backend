/**
 * Google Identity — the Google sign-in was disconnected from this account.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Google sign-in was removed from your account',
    paragraphs: (_v, ctx) => [
      `Google can no longer be used to sign in to your ${ctx.branding.platformName} account. Your password still works.`,
      'If this was you, no action is needed. If it was not, reset your password now and contact support.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تمت إزالة تسجيل الدخول عبر Google من حسابك',
    paragraphs: (_v, ctx) => [
      `لم يعد بالإمكان استخدام Google لتسجيل الدخول إلى حسابك في ${ctx.branding.platformName}. ما زالت كلمة المرور تعمل.`,
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
