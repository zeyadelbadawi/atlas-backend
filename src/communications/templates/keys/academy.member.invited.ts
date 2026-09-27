import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * You've been invited to an academy, and an Atlas account was created for you.
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
export function roleLabel(values: Record<string, unknown>, locale: 'en' | 'ar'): string {
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
  version: '2',
  en: defineLocale({
    subject: (v) =>
      `You've been invited to ${str(v, 'academyName', 'an academy')} on Atlas`,
    preheader: () => 'Set up your Atlas account to get started.',
    paragraphs: (v) => [
      `You've been invited to join ${str(v, 'academyName', 'an academy')} as ${roleLabel(v, 'en')}. We've created an Atlas account for you.`,
      `You sign in with ${str(v, 'email')}.`,
      `Set up your account by choosing a password, then continue into the academy. This link works once and expires in ${str(v, 'expiresInHours', '72')} hours — if it lapses, use "Forgot password" on the sign-in page.`,
    ],
    ctaLabel: 'Set up your account',
  }),
  ar: defineLocale({
    subject: (v) =>
      `تمت دعوتك إلى ${str(v, 'academyName', 'إحدى الأكاديميات')} على Atlas`,
    preheader: () => 'أنشئ حسابك على Atlas للبدء.',
    paragraphs: (v) => [
      `تمت دعوتك للانضمام إلى ${str(v, 'academyName', 'إحدى الأكاديميات')} بصفة ${roleLabel(v, 'ar')}. أنشأنا لك حسابًا على Atlas.`,
      `تسجّل الدخول باستخدام ${str(v, 'email')}.`,
      `أنشئ حسابك باختيار كلمة مرور، ثم تابع إلى الأكاديمية. يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته خلال ${str(v, 'expiresInHours', '72')} ساعة — وإذا انتهت، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.`,
    ],
    ctaLabel: 'إنشاء حسابك',
  }),
};
