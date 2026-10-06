import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Reset your password',
    paragraphs: (_v, ctx) => [
      `We received a request to reset the password of your ${ctx.branding.academyName ?? ctx.branding.platformName} account.`,
      'The link expires shortly and can be used once. If you did not ask for this, ignore this email — your password stays unchanged.',
    ],
    ctaLabel: 'Reset password',
  }),
  ar: defineLocale({
    subject: () => 'إعادة تعيين كلمة المرور',
    paragraphs: (_v, ctx) => [
      `تلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في ${ctx.branding.academyName ?? ctx.branding.platformName}.`,
      'ينتهي الرابط خلال وقت قصير ويُستخدم مرة واحدة. إذا لم تطلب ذلك، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.',
    ],
    ctaLabel: 'إعادة تعيين كلمة المرور',
  }),
};
