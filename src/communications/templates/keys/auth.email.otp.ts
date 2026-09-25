/**
 * The emailed sign-in code (P64 Communications C4, §12).
 *
 * The one template whose PAYLOAD is the message: the code is the point,
 * so it gets its own line, in the first paragraph, with nothing competing
 * for attention around it. No call to action and no link at all — a
 * sign-in code email that carries a clickable link is exactly the shape
 * every phishing lookalike copies, and there is nothing here for an
 * honest recipient to click: they already have the page open.
 *
 * The digits stay LTR in both locales. `renderHtmlLayout` escapes every
 * value and sets `dir` from the locale, and a six-digit run is rendered
 * by the bidi algorithm left-to-right inside an RTL paragraph anyway, so
 * an Arabic reader sees the same digits in the same order as the input
 * boxes on screen — which is the whole reason the frontend marks its slot
 * group `dir="ltr"`.
 *
 * The last line is the "wasn't you?" line §34 asks every security email
 * to carry. It tells the reader the only thing that is actually true and
 * actionable: nobody is in the account yet, and a password change is the
 * fix — never "click here to secure your account", which is a link.
 */
import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (values) => `${str(values, 'code')} is your sign-in code`,
    preheader: () => 'Use this code to finish signing in.',
    paragraphs: (values, ctx) => [
      `Your ${ctx.branding.academyName ?? ctx.branding.platformName} sign-in code is:`,
      str(values, 'code'),
      `Enter it on the sign-in page. It expires in ${str(values, 'expiresInMinutes', '10')} minutes and can be used once.`,
      'If you did not try to sign in, someone may know your password — nobody has been let in, but change it as soon as you can.',
    ],
  }),
  ar: defineLocale({
    subject: (values) => `${str(values, 'code')} هو رمز تسجيل الدخول`,
    preheader: () => 'استخدم هذا الرمز لإكمال تسجيل الدخول.',
    paragraphs: (values, ctx) => [
      `رمز تسجيل الدخول إلى ${ctx.branding.academyName ?? ctx.branding.platformName}:`,
      str(values, 'code'),
      `أدخله في صفحة تسجيل الدخول. تنتهي صلاحيته خلال ${str(values, 'expiresInMinutes', '10')} دقائق ويُستخدم مرة واحدة.`,
      'إذا لم تحاول تسجيل الدخول، فقد يعرف أحدهم كلمة مرورك — لم يدخل أحد إلى حسابك، لكن غيّر كلمة المرور في أقرب وقت.',
    ],
  }),
};
