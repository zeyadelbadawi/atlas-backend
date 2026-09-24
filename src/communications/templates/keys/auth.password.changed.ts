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
  }),
  ar: defineLocale({
    subject: () => 'تم تغيير كلمة المرور',
    paragraphs: (_v, ctx) => [
      `تم للتو تغيير كلمة مرور حسابك في ${ctx.branding.platformName}.`,
      'إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء. وإن لم تكن أنت، أعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
    ],
  }),
};
