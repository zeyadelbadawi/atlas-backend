import { defineLocale, str } from '../layout';
import type { CommunicationTemplate, TemplateValues } from '../layout';

/**
 * §27 S1 — the receipt that was missing beside the existing "payment
 * approved" notice: which plan, which period, and the capacity this
 * purchase FROZE.
 *
 * The three numbers come from the subscription's `granted_limits` (P61),
 * never from the live catalogue, so a later catalogue edit can never make
 * this receipt retroactively untrue. `'unlimited'` is a real limit value,
 * not a missing one, so each locale renders it as a word rather than
 * printing the English token into an Arabic sentence.
 *
 * W8 — GIFTED DAYS. When the approval that produced this receipt also
 * granted the first-paid-subscription gift, the producer adds `giftedDays`,
 * `giftStartDate` and `giftEndDate`, read from the `tenant_subscriptions`
 * row that same transaction wrote. The receipt then separates the two
 * segments the customer actually has: the free gifted days first, then the
 * paid period (`periodStartDate` is the gift's end, `periodEndDate` the
 * renewal/expiry date). Without all three gift values — a renewal, an
 * ineligible customer, a plan without a gift — the copy is the plain
 * receipt and says nothing about gifted days at all, never "0 days".
 *
 * v2 — the gifted-days copy, and (Arabic only) dates wrapped as
 * left-to-right isolates so `2026-10-04 10:00 UTC` reads as one unit
 * inside a right-to-left sentence instead of being reordered by the
 * bidirectional algorithm.
 */
function limit(values: TemplateValues, key: string, unlimitedWord: string): string {
  const raw = str(values, key);
  if (!raw) return '';
  return raw === 'unlimited' ? unlimitedWord : raw;
}

function capacity(
  values: TemplateValues,
  unlimitedWord: string,
  separator: string,
  nouns: { academies: string; students: string; courses: string },
): string {
  return (
    [
      [limit(values, 'academiesLimit', unlimitedWord), nouns.academies] as const,
      [limit(values, 'studentsLimit', unlimitedWord), nouns.students] as const,
      [limit(values, 'coursesLimit', unlimitedWord), nouns.courses] as const,
    ]
      .filter(([count]) => count !== '')
      // Every limit is absent when the subscription predates P61 and
      // recorded no grant — the paragraph then falls back to pointing at
      // the subscription page rather than inventing numbers.
      .map(([count, noun]) => `${count} ${noun}`)
      .join(separator)
  );
}

interface GiftCopy {
  readonly days: number;
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * The gift this receipt reports, or `null` when there is none to report.
 * All three values must be present and the count a positive whole number:
 * a partial or zero gift is treated as no gift, so the reader is never
 * told about "0 gifted days" or a gift with no dates.
 */
function giftOf(values: TemplateValues): GiftCopy | null {
  const raw = values.giftedDays;
  const days = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) return null;
  const startDate = str(values, 'giftStartDate');
  const endDate = str(values, 'giftEndDate');
  if (!startDate || !endDate) return null;
  return { days, startDate, endDate };
}

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
function ltr(value: string): string {
  return value ? `⁦${value}⁩` : value;
}

/** Arabic counted noun for "day": 1 / 2 / 3–10 / 11+. */
function arabicDays(days: number): string {
  if (days === 1) return 'يوم واحد';
  if (days === 2) return 'يومان';
  if (days <= 10) return `${days} أيام`;
  return `${days} يومًا`;
}

export const template: CommunicationTemplate = {
  version: '2',
  en: defineLocale({
    subject: (v) => `Your ${str(v, 'planName', 'Atlas')} subscription is active`,
    paragraphs: (v) => {
      const plan = str(v, 'planName', 'Atlas');
      const start = str(v, 'periodStartDate');
      const end = str(v, 'periodEndDate');
      const limits = capacity(v, 'unlimited', ', ', {
        academies: 'academies',
        students: 'students',
        courses: 'courses',
      });
      const gift = giftOf(v);
      const period = gift
        ? [
            `Your subscription to ${plan} is active now. It starts with gifted days, followed by the period you paid for.`,
            `Gifted days: ${gift.days} ${gift.days === 1 ? 'day' : 'days'}, from ${gift.startDate} to ${gift.endDate}. These days are free and are not taken from the period you paid for.`,
            `Paid subscription period: from ${start} to ${end}. Your subscription expires on ${end} unless you renew it.`,
          ]
        : [`Your subscription to ${plan} is active from ${start} to ${end}.`];
      return [
        ...period,
        limits
          ? `This plan includes ${limits}.`
          : 'The limits this plan includes are shown on your subscription page.',
        'Your public website is being served and changes are unblocked. We will remind you before the period ends.',
      ];
    },
    ctaLabel: 'View subscription',
  }),
  ar: defineLocale({
    subject: (v) => `اشتراكك في ${str(v, 'planName', 'أطلس')} فعّال الآن`,
    paragraphs: (v) => {
      const plan = str(v, 'planName', 'أطلس');
      const start = ltr(str(v, 'periodStartDate'));
      const end = ltr(str(v, 'periodEndDate'));
      const limits = capacity(v, 'عدد غير محدود من', '، ', {
        academies: 'أكاديميات',
        students: 'طلاب',
        courses: 'دورات',
      });
      const gift = giftOf(v);
      const period = gift
        ? [
            `اشتراكك في ${plan} فعّال الآن. يبدأ بأيام مُهداة، تليها الفترة التي دفعت مقابلها.`,
            `الأيام المُهداة: ${arabicDays(gift.days)}، من ${ltr(gift.startDate)} حتى ${ltr(gift.endDate)}. هذه الأيام مجانية ولا تُخصم من الفترة التي دفعت مقابلها.`,
            `فترة الاشتراك المدفوعة: من ${start} حتى ${end}. ينتهي اشتراكك في ${end} ما لم تجدّده.`,
          ]
        : [`اشتراكك في ${plan} فعّال من ${start} حتى ${end}.`];
      return [
        ...period,
        limits
          ? `تشمل هذه الخطة ${limits}.`
          : 'الحدود التي تشملها هذه الخطة موضّحة في صفحة اشتراكك.',
        'موقعك العام معروض والتعديلات متاحة. سنذكّرك قبل انتهاء الفترة.',
      ];
    },
    ctaLabel: 'عرض الاشتراك',
  }),
};
