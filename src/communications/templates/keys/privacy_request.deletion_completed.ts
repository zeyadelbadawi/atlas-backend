/**
 * B0-SEC-13 — the account was deleted at the person's request. Sent to the
 * address recorded on the request, because the account is already
 * anonymised. No link: there is nothing left to sign in to.
 */
import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your account has been deleted',
    paragraphs: (_v, ctx) => [
      `As you requested, your ${ctx.branding.platformName} account has been deleted. You can no longer sign in, and every session has ended.`,
      'Records we must keep, such as payment records, are retained as described in our Privacy Policy.',
      'This is the last email about this account.',
    ],
  }),
  ar: defineLocale({
    subject: () => 'تم حذف حسابك',
    paragraphs: (_v, ctx) => [
      `بناءً على طلبك، تم حذف حسابك على ${ctx.branding.platformName}. لم يعد بإمكانك تسجيل الدخول، وانتهت جميع الجلسات.`,
      'السجلات التي يجب علينا الاحتفاظ بها، مثل سجلات المدفوعات، تُحفظ وفق ما توضحه سياسة الخصوصية.',
      'هذه آخر رسالة بخصوص هذا الحساب.',
    ],
  }),
};
