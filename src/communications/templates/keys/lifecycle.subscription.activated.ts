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

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your ${str(v, 'planName', 'Atlas')} subscription is active`,
    paragraphs: (v) => {
      const limits = capacity(v, 'unlimited', ', ', {
        academies: 'academies',
        students: 'students',
        courses: 'courses',
      });
      return [
        `Your subscription to ${str(v, 'planName', 'Atlas')} is active from ${str(v, 'periodStartDate')} to ${str(v, 'periodEndDate')}.`,
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
      const limits = capacity(v, 'عدد غير محدود من', '، ', {
        academies: 'أكاديميات',
        students: 'طلاب',
        courses: 'دورات',
      });
      return [
        `اشتراكك في ${str(v, 'planName', 'أطلس')} فعّال من ${str(v, 'periodStartDate')} حتى ${str(v, 'periodEndDate')}.`,
        limits
          ? `تشمل هذه الخطة ${limits}.`
          : 'الحدود التي تشملها هذه الخطة موضّحة في صفحة اشتراكك.',
        'موقعك العام معروض والتعديلات متاحة. سنذكّرك قبل انتهاء الفترة.',
      ];
    },
    ctaLabel: 'عرض الاشتراك',
  }),
};
