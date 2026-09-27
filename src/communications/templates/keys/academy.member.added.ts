import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { roleLabel } from './academy.member.invited';

/**
 * An academy owner added your EXISTING Atlas account to their academy.
 *
 * Unlike the invitation, the reader already has an account and a password,
 * so this message asks for nothing: it says where they now have access, in
 * what role, and that they get in with the email and password they already
 * use. It deliberately does not mention changing anything — nothing about
 * the account was changed. One template serves both the staff key
 * (`academy.member.added`, management host) and the learner key
 * (`academy.learner.added`, academy host); the CTA's host comes from the
 * catalogue entry's branding.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `You've been added to ${str(v, 'academyName', 'an academy')} on Atlas`,
    preheader: () => 'Sign in with your existing Atlas account.',
    paragraphs: (v) => [
      `You now have access to ${str(v, 'academyName', 'an academy')} as ${roleLabel(v, 'en')}.`,
      'Sign in with the email and password you already use for Atlas. Nothing about your account has changed.',
    ],
    ctaLabel: 'Open Academy',
  }),
  ar: defineLocale({
    subject: (v) =>
      `تمت إضافتك إلى ${str(v, 'academyName', 'إحدى الأكاديميات')} على Atlas`,
    preheader: () => 'سجّل الدخول بحسابك الحالي على Atlas.',
    paragraphs: (v) => [
      `أصبح لديك وصول إلى ${str(v, 'academyName', 'إحدى الأكاديميات')} بصفة ${roleLabel(v, 'ar')}.`,
      'سجّل الدخول بالبريد الإلكتروني وكلمة المرور اللذين تستخدمهما بالفعل على Atlas. لم يتغيّر شيء في حسابك.',
    ],
    ctaLabel: 'فتح الأكاديمية',
  }),
};
