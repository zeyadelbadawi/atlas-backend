import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B2 — a Founding Academy's next renewal is no longer at its locked
 * price (the 24-month lock has ended before that renewal, or the
 * membership was revoked) and the catalog price it will be charged
 * differs. Sent once per renewal, about 30 days before the period ends
 * (`FoundingNoticeService`), so the promise on /founding holds: "If it is
 * different from yours, we email you before the renewal."
 */
function ltr(value: string): string {
  return value ? `⁦${value}⁩` : value;
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your next renewal is at the current catalog price',
    paragraphs: (v) => [
      `Your Founding Academy price of ${ltr(str(v, 'lockedPrice'))} a year covered your plan until ${str(v, 'lockEndDate')}.`,
      `Your ${str(v, 'planName', 'Atlas')} plan renews on ${str(v, 'renewalDate')} at the current yearly price of ${ltr(str(v, 'renewalPrice'))}.`,
      'Nothing changes before then, and the plan page shows the details.',
    ],
    ctaLabel: 'View my plan',
  }),
  ar: defineLocale({
    subject: () => 'تجديدك الجاي بسعر الكتالوج الحالي',
    paragraphs: (v) => [
      `سعرك كأكاديمية مؤسِّسة ${ltr(str(v, 'lockedPrice'))} في السنة كان ثابتًا لباقتك حتى ${str(v, 'lockEndDate')}.`,
      `باقة ${str(v, 'planName', 'أطلس')} هتتجدد يوم ${str(v, 'renewalDate')} بالسعر السنوي الحالي ${ltr(str(v, 'renewalPrice'))}.`,
      'مفيش حاجة هتتغير قبل كده، والتفاصيل في صفحة الباقة.',
    ],
    ctaLabel: 'شوف باقتي',
  }),
};
