/**
 * B0-SEC-13 — the emailed code that confirms filing a privacy request (a
 * copy of the reader's data, or deletion of their account).
 *
 * Says what the code is for, so a person who did not ask recognises that
 * someone signed in as them is trying to file one. No link — the code is
 * typed into the page that asked for it. Digits stay LTR in both locales
 * (see `auth.email.otp`).
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    // The code is NOT in the subject (see `auth.email.otp`).
    subject: () => 'Your code to confirm a privacy request',
    preheader: () =>
      'Only enter this code if you asked for a copy of your data or for your account to be deleted.',
    paragraphs: (values, ctx) => [
      `Someone signed in to your ${ctx.branding.platformName} account asked for a copy of their data or for the account to be deleted. The confirmation code is:`,
      str(values, 'code'),
      `It expires in ${str(values, 'expiresInMinutes', '10')} minutes and can be used once.`,
      'If this was not you, do not share this code. Nothing has been requested yet — change your password now, because someone else is signed in to your account.',
    ],
  }),
  ar: defineLocale({
    subject: () => 'رمز تأكيد طلب الخصوصية',
    preheader: () => 'لا تُدخل هذا الرمز إلا إذا طلبت نسخة من بياناتك أو حذف حسابك.',
    paragraphs: (values, ctx) => [
      `طلب شخص مسجّل الدخول إلى حسابك على ${ctx.branding.platformName} نسخة من بياناته أو حذف الحساب. رمز التأكيد هو:`,
      str(values, 'code'),
      `تنتهي صلاحيته خلال ${str(values, 'expiresInMinutes', '10')} دقائق ويُستخدم مرة واحدة.`,
      'إذا لم تكن أنت، فلا تشارك هذا الرمز. لم يُقدَّم أي طلب بعد — غيّر كلمة المرور الآن، لأن شخصًا آخر مسجّل الدخول إلى حسابك.',
    ],
  }),
};
