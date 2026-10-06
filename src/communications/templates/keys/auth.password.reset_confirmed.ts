/**
 * A security notice that must offer a way OUT.
 *
 * Plan §13 asks every A5/A6 security email to carry an "if this wasn't
 * you" recovery path. The copy said "reset your password now" with
 * nothing to click, which is the same shape of dead end the raw-token
 * emails had: an instruction the reader cannot act on from where they
 * are. The CTA points at the forgot-password page, which is reachable
 * without being signed in — the state someone is in precisely when this
 * email is the one that matters.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Your password was reset',
    paragraphs: (_v, ctx) => [
      `The password of your ${ctx.branding.academyName ?? ctx.branding.platformName} account was reset and every other session was signed out.`,
      'If this was not you, contact support immediately.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تمت إعادة تعيين كلمة المرور',
    paragraphs: (_v, ctx) => [
      `تمت إعادة تعيين كلمة مرور حسابك في ${ctx.branding.academyName ?? ctx.branding.platformName} وتم تسجيل الخروج من كل الجلسات الأخرى.`,
      'إذا لم تكن أنت من قام بذلك، تواصل مع الدعم فورًا.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
