/**
 * ATO review F3 — two-factor authentication was turned on for this
 * account. A security notice: whoever holds the authenticator now controls
 * every sign-in, so if it was not the owner they hear about it at once.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Two-factor authentication was turned on',
    paragraphs: (_v, ctx) => [
      `Two-factor authentication is now on for your ${ctx.branding.platformName} account. Signing in will ask for a code from your authenticator app.`,
      'If this was you, keep your recovery codes somewhere safe. If it was not, reset your password now and contact support.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تم تفعيل التحقق بخطوتين',
    paragraphs: (_v, ctx) => [
      `أصبح التحقق بخطوتين مفعّلًا لحسابك في ${ctx.branding.platformName}. سيُطلب منك عند تسجيل الدخول رمز من تطبيق المصادقة.`,
      'إذا كنت أنت من قام بذلك فاحتفظ برموز الاسترداد في مكان آمن. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
