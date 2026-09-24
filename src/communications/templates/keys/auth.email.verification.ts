import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Verify your email address',
    paragraphs: (_v, ctx) => [
      `Confirm that this address belongs to your ${ctx.branding.platformName} account.`,
      'This link is valid for a limited time and can be used once. If you did not create an account, ignore this email.',
    ],
    ctaLabel: 'Verify email',
  }),
  ar: defineLocale({
    subject: () => 'تأكيد عنوان بريدك الإلكتروني',
    paragraphs: (_v, ctx) => [
      `أكّد أن هذا العنوان يخص حسابك في ${ctx.branding.platformName}.`,
      'هذا الرابط صالح لفترة محدودة ويُستخدم مرة واحدة. إذا لم تنشئ حسابًا، تجاهل هذه الرسالة.',
    ],
    ctaLabel: 'تأكيد البريد',
  }),
};
