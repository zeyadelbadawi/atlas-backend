/**
 * Shared copy for the three learner-exception emails.
 *
 * All three describe the SAME row (`QuizStudentOverride`) at three moments
 * of its life, so the sentence that says what the accommodation actually
 * IS must read identically in all of them — a learner who is told "1.5×
 * the usual time limit" when it is granted and something differently
 * worded when it activates has to work out for themselves whether those
 * are the same thing.
 *
 * WHAT IS DELIBERATELY ABSENT: the override's `reason`. It is free text a
 * reviewer writes ABOUT a student — the note may record a disability, an
 * illness or a family bereavement — and it is the one field of this row
 * that has no business being mailed back at them, or sitting in an inbox
 * their family can read. The learner needs to know what they were given
 * and when it applies; they already know why.
 */
import { str } from '../layout';
import type { TemplateValues } from '../layout';

/** `1.5` when extra time was granted, `''` when the multiplier is the ordinary 1. */
export function extraTime(values: TemplateValues): string {
  const multiplier = str(values, 'timeMultiplier');
  return multiplier === '' || Number(multiplier) <= 1 ? '' : multiplier;
}

/** `2` when extra attempts were granted, `''` for none. */
export function extraAttempts(values: TemplateValues): string {
  const attempts = Number(str(values, 'extraAttempts'));
  return Number.isFinite(attempts) && attempts > 0 ? String(attempts) : '';
}

/** "It gives you 1.5× the usual time limit and 2 more attempts." */
export function adjustmentsEn(values: TemplateValues): string {
  const time = extraTime(values);
  const attempts = extraAttempts(values);
  const parts: string[] = [];
  if (time) parts.push(`${time}× the usual time limit`);
  if (attempts)
    parts.push(`${attempts} more ${attempts === '1' ? 'attempt' : 'attempts'}`);
  if (parts.length === 0)
    return 'It sets your own dates for this quiz rather than the ones everyone else has.';
  return `It gives you ${parts.join(' and ')}.`;
}

/** The same sentence in Arabic, written to avoid number/gender agreement traps. */
export function adjustmentsAr(values: TemplateValues): string {
  const time = extraTime(values);
  const attempts = extraAttempts(values);
  const parts: string[] = [];
  if (time) parts.push(`${time} من الوقت المعتاد`);
  if (attempts) parts.push(`محاولات إضافية (العدد: ${attempts})`);
  if (parts.length === 0)
    return 'يمنحك هذا الاستثناء مواعيد خاصة بك لهذا الاختبار بدلًا من المواعيد المعتادة.';
  return `يمنحك هذا الاستثناء ${parts.join('، و')}.`;
}

/** "Your window stays open until <date>." — omitted when the exception has no end. */
export function untilEn(
  values: TemplateValues,
  opening = 'Your window stays open',
): string {
  const until = str(values, 'availableUntilLabel');
  return until ? `${opening} until ${until}.` : '';
}

export function untilAr(values: TemplateValues, opening = 'تبقى مهلتك مفتوحة'): string {
  const until = str(values, 'availableUntilLabel');
  return until ? `${opening} حتى ${until}.` : '';
}

/** Drops the sentences a branch did not produce, so no empty paragraph renders. */
export function lines(...candidates: readonly string[]): string[] {
  return candidates.filter((line) => line.trim().length > 0);
}
