import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Verify your email address.
 *
 * States HOW LONG the link works (`expiresInHours`, from
 * `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES`; 24 by default) instead of "a
 * limited time", so a reader who opens it tomorrow knows whether to click
 * or to ask for a new one. Names the academy when the account was created
 * on an academy website — that is the brand the reader signed up with.
 * Values written before `expiresInHours` existed fall back to the 24h
 * default, which is what those links were issued with.
 */
export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: () => 'Verify your email address',
    paragraphs: (v, ctx) => [
      `Confirm that this address belongs to your ${ctx.branding.academyName ?? ctx.branding.platformName} account.`,
      `This link works once and expires in ${str(v, 'expiresInHours', '24')} hours. If it has expired, sign in and request a new one. If you did not create an account, ignore this email.`,
    ],
    ctaLabel: 'Verify email',
  }),
  ar: defineLocale({
    subject: () => 'تأكيد عنوان بريدك الإلكتروني',
    paragraphs: (v, ctx) => [
      `أكّد أن هذا العنوان يخص حسابك في ${ctx.branding.academyName ?? ctx.branding.platformName}.`,
      `يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال ${str(v, 'expiresInHours', '24')} ساعة. إذا انتهت صلاحيته، سجّل الدخول واطلب رابطًا جديدًا. إذا لم تنشئ حسابًا، تجاهل هذه الرسالة.`,
    ],
    ctaLabel: 'تأكيد البريد',
  }),
};
