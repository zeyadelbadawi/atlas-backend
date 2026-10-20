/**
 * Owner decision (20 Oct 2026): an Academy's slug — its public address —
 * may change at most once every 60 days. Every change counts, taking back
 * one of the Academy's own old addresses included; creating the Academy
 * does not (`slug_changed_at` stays NULL until the first change), so the
 * first change after creation is always allowed.
 *
 * Pure, so the API refusal and the academy response name the same date.
 */
export const SLUG_CHANGE_INTERVAL_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the next slug change becomes possible, or `null` when one is possible now. */
export function nextSlugChangeAt(
  slugChangedAt: Date | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!slugChangedAt) return null;
  const next = new Date(slugChangedAt.getTime() + SLUG_CHANGE_INTERVAL_DAYS * DAY_MS);
  return next.getTime() > now.getTime() ? next : null;
}
