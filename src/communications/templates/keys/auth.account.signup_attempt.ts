/**
 * Someone tried to create an account with an address that already has one
 * (authentication audit, Decision 3 — registration never reveals whether
 * an address exists). The sign-up page answered exactly as for a new
 * address; THIS email is how the real owner learns the next step. At most
 * one an hour per person (catalogue dedupe window).
 *
 * It names every legitimate way back in without saying which one this
 * account uses (that would tell a forwarder the account's sign-in method):
 * sign in with the password, sign in with Google, or reset the password.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'You already have an account',
    preheader: () => 'Someone tried to sign up with this email address.',
    paragraphs: (_values, ctx) => [
      `Someone tried to create an account on ${ctx.branding.academyName ?? ctx.branding.platformName} with this email address, which already has an account. Nothing was changed and no new account was created.`,
      'If it was you, sign in instead — with your password, or with Google if you use it. Forgot your password? Use "Forgot password" on the sign-in page to set a new one.',
      'If it was not you, you can ignore this email.',
    ],
  }),
  ar: defineLocale({
    subject: () => 'لديك حساب بالفعل',
    preheader: () => 'حاول شخص إنشاء حساب بعنوان البريد الإلكتروني هذا.',
    paragraphs: (_values, ctx) => [
      `حاول شخص إنشاء حساب على ${ctx.branding.academyName ?? ctx.branding.platformName} بعنوان البريد الإلكتروني هذا، ولديه حساب بالفعل. لم يتغير شيء ولم يُنشأ حساب جديد.`,
      'إذا كنت أنت، فسجّل الدخول بدلًا من ذلك — بكلمة المرور، أو باستخدام Google إذا كنت تستخدمه. نسيت كلمة المرور؟ استخدم "نسيت كلمة المرور" في صفحة تسجيل الدخول لتعيين كلمة جديدة.',
      'إذا لم تكن أنت، يمكنك تجاهل هذه الرسالة.',
    ],
  }),
};
