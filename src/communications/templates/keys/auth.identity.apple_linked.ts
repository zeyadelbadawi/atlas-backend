/**
 * Atlas mobile app (B2) — Sign in with Apple was connected to this Atlas
 * account (the owner proved it with their password in the app). A security
 * notice: if it was not the owner, they hear about it and have a way out.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Sign in with Apple was connected to your account',
    paragraphs: (_v, ctx) => [
      `You can now sign in to your ${ctx.branding.platformName} account with Apple, as well as with your existing sign-in method.`,
      'Nothing else about your account changed.',
      'If this was you, no action is needed. If it was not, reset your password now and contact support.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تم ربط تسجيل الدخول عبر Apple بحسابك',
    paragraphs: (_v, ctx) => [
      `يمكنك الآن تسجيل الدخول إلى حسابك في ${ctx.branding.platformName} باستخدام Apple، إضافةً إلى طريقة تسجيل الدخول الحالية.`,
      'لم يتغير أي شيء آخر في حسابك.',
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
