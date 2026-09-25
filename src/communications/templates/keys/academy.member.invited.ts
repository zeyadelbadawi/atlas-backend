import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Somebody created an Atlas account for you.
 *
 * The reader did not ask for this and may not know Atlas exists, so the
 * email has to answer four questions before it asks for anything: who
 * made the account, for which academy, in what role, and which address
 * signs in. The last matters more than it looks — a person with two
 * mailboxes needs to know which one is the username.
 *
 * There is NO password in this message and never will be. The CTA carries
 * a one-time link that lets them choose their own; that is the whole
 * reason the flow exists instead of an owner relaying a password by hand.
 */
function roleLabel(values: Record<string, unknown>, locale: 'en' | 'ar'): string {
  const role = str(values, 'role');
  const en: Record<string, string> = {
    manager: 'Manager',
    instructor: 'Instructor',
    student: 'Learner',
  };
  const ar: Record<string, string> = {
    manager: 'مدير',
    instructor: 'مدرّب',
    student: 'متعلّم',
  };
  const table = locale === 'en' ? en : ar;
  return table[role] ?? role;
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `You've been added to ${str(v, 'academyName', 'an academy')} on Atlas`,
    preheader: () => 'Set your password to get started.',
    paragraphs: (v) => [
      `An account has been created for you at ${str(v, 'academyName', 'an academy')} as ${roleLabel(v, 'en')}.`,
      `You sign in with ${str(v, 'email')}.`,
      `Choose a password to get started. This link works once and expires in ${str(v, 'expiresInHours', '72')} hours — if it lapses, use "Forgot password" on the sign-in page.`,
    ],
    ctaLabel: 'Set your password',
  }),
  ar: defineLocale({
    subject: (v) =>
      `تمت إضافتك إلى ${str(v, 'academyName', 'إحدى الأكاديميات')} على Atlas`,
    preheader: () => 'اختر كلمة المرور للبدء.',
    paragraphs: (v) => [
      `تم إنشاء حساب لك في ${str(v, 'academyName', 'إحدى الأكاديميات')} بصفة ${roleLabel(v, 'ar')}.`,
      `تسجّل الدخول باستخدام ${str(v, 'email')}.`,
      `اختر كلمة مرور للبدء. يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال ${str(v, 'expiresInHours', '72')} ساعة — وإذا انتهت، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.`,
    ],
    ctaLabel: 'اختيار كلمة المرور',
  }),
};
