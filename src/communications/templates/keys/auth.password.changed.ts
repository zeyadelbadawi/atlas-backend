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
  version: '1',
  en: defineLocale({
    subject: () => 'Your password was changed',
    paragraphs: (_v, ctx) => [
      `Your ${ctx.branding.platformName} account password was just changed.`,
      'If this was you, no action is needed. If it was not, reset your password now and contact support immediately.',
    ],
    ctaLabel: 'Reset your password',
  }),
  ar: defineLocale({
    subject: () => 'تم تغيير كلمة المرور',
    paragraphs: (_v, ctx) => [
      `تم للتو تغيير كلمة مرور حسابك في ${ctx.branding.platformName}.`,
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
