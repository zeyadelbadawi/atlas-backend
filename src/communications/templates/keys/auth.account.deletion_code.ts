/**
 * The emailed code that confirms deleting the reader's OWN account
 * (authentication audit, Decision 1).
 *
 * Deliberately not the sign-in code's wording: the subject and first line
 * say DELETION, so a person who did not ask for it recognises at once
 * that somebody signed in as them is trying to erase the account. No
 * link — the code is typed into the page that asked for it.
 *
 * The digits stay LTR in both locales (see `auth.email.otp`).
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    // W3 security fix — the code is NOT in the subject (see `auth.email.otp`).
    subject: () => 'Your code to delete your account',
    preheader: () => 'Only enter this code if you want to delete your account.',
    paragraphs: (values, ctx) => [
      `Someone signed in to your ${ctx.branding.platformName} account asked to delete it permanently. The confirmation code is:`,
      str(values, 'code'),
      `It expires in ${str(values, 'expiresInMinutes', '10')} minutes and can be used once. Deleting the account cannot be undone: every session ends and any academies you own are taken offline.`,
      'If this was not you, do not share this code. Nothing has been deleted — change your password now, because someone else is signed in to your account.',
    ],
  }),
  ar: defineLocale({
    subject: () => 'رمز حذف حسابك',
    preheader: () => 'لا تُدخل هذا الرمز إلا إذا كنت تريد حذف حسابك.',
    paragraphs: (values, ctx) => [
      `طلب شخص مسجّل الدخول إلى حسابك على ${ctx.branding.platformName} حذفه نهائيًا. رمز التأكيد هو:`,
      str(values, 'code'),
      `تنتهي صلاحيته خلال ${str(values, 'expiresInMinutes', '10')} دقائق ويُستخدم مرة واحدة. لا يمكن التراجع عن حذف الحساب: تنتهي جميع الجلسات وتتوقف أي أكاديميات تملكها عن العمل.`,
      'إذا لم تكن أنت، فلا تشارك هذا الرمز. لم يُحذف شيء — غيّر كلمة المرور الآن، لأن شخصًا آخر مسجّل الدخول إلى حسابك.',
    ],
  }),
};
