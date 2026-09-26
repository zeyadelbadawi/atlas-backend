/**
 * Launch Stabilization A4 — your existing account was added to an academy.
 *
 * One Atlas account can learn at several academies. When someone signs up
 * at a new academy with an email that already has an account, the
 * account's own password is required and the account is NOT duplicated —
 * it simply gains access to that academy. This notice tells the owner,
 * and offers the way out if it was not them.
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Your account now has access to ${str(v, 'academyName', 'a new academy')}`,
    paragraphs: (v, ctx) => [
      `Your ${ctx.branding.platformName} account was just used to join ${str(v, 'academyName', 'a new academy')}. You can now sign in there with your existing email and password.`,
      'Nothing else about your account changed.',
      'If this was you, no action is needed. If it was not, reset your password now and contact support.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: (v) => `أصبح لحسابك وصول إلى ${str(v, 'academyName', 'أكاديمية جديدة')}`,
    paragraphs: (v, ctx) => [
      `تم للتو استخدام حسابك في ${ctx.branding.platformName} للانضمام إلى ${str(v, 'academyName', 'أكاديمية جديدة')}. يمكنك الآن تسجيل الدخول هناك بالبريد الإلكتروني وكلمة المرور الحاليين.`,
      'لم يتغير أي شيء آخر في حسابك.',
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
