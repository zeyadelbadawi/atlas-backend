import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 W4 — the last call, twenty-four hours out, and deliberately SHORT.
 *
 * Three sentences. Someone reading this has either decided or has not
 * seen the previous three, and neither of them is helped by a fourth long
 * email. §31 also requires this one to go out "even if W1-W3 bounced",
 * which is a property of the catalogue entry (`email: 'always'`), not of
 * the copy.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Last call: your hosted videos are deleted tomorrow',
    paragraphs: (v) => [
      `Tomorrow, on ${str(v, 'deletionAtDate')}, the ${str(v, 'videoCount')} video file(s) hosted for your academy will be permanently deleted.`,
      'Reactivating your subscription today stops it. Nothing else you have is affected.',
    ],
    ctaLabel: 'Reactivate now',
  }),
  ar: defineLocale({
    subject: () => 'نداء أخير: ستُحذف مقاطعك المستضافة غدًا',
    paragraphs: (v) => [
      `غدًا، في ${str(v, 'deletionAtDate')}، ستُحذف نهائيًا ${str(v, 'videoCount')} ملف فيديو مستضاف لأكاديميتك.`,
      'إعادة تفعيل اشتراكك اليوم توقف ذلك. ولا يتأثر أي شيء آخر لديك.',
    ],
    ctaLabel: 'إعادة التفعيل الآن',
  }),
};
