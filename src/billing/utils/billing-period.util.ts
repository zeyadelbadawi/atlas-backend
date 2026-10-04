/**
 * Billing-period date arithmetic (W8). Pure, UTC-only, unit-tested.
 *
 * D3 — the previous `addPeriod` used `Date#setMonth`/`setFullYear` in the
 * server's local zone, which OVERFLOWS: 31 Jan + 1 month became 2/3 March,
 * and 29 Feb + 1 year became 1 March. A customer who paid on the 31st lost
 * the shorter month's end and drifted a few days every renewal. The rule
 * now is the calendar rule customers expect: same day-of-month, clamped to
 * the last day of the target month (31 Jan → 28/29 Feb, 29 Feb → 28 Feb
 * next year), time of day preserved, all in UTC.
 *
 * D4 — the billing cycle of a purchase is resolved from the checkout's own
 * column first, then the frozen snapshot (a natively yearly plan bought
 * without an explicit cycle stored NULL on the column but `yearly` on the
 * snapshot, and used to be treated as monthly), then monthly.
 */
import type { SubscriptionBillingCycle } from '@prisma/client';

export const DAY_MS = 24 * 60 * 60 * 1000;

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Adds whole calendar months in UTC, clamping the day to the target month's last day. */
export function addCalendarMonthsUtc(start: Date, months: number): Date {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(start.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

/** End of one paid period starting at `start`. */
export function addBillingPeriod(
  start: Date,
  billingCycle: SubscriptionBillingCycle,
): Date {
  return addCalendarMonthsUtc(start, billingCycle === 'yearly' ? 12 : 1);
}

/** Fixed 24h days (UTC milliseconds) — the gifted segment is days, not calendar months. */
export function addDaysUtc(start: Date, days: number): Date {
  return new Date(start.getTime() + days * DAY_MS);
}

/**
 * D4 — the cycle a purchase is actually for. `checkout.billing_cycle` may be
 * NULL while the frozen snapshot carries the plan's native cycle.
 */
export function resolvePurchaseBillingCycle(
  checkoutBillingCycle: SubscriptionBillingCycle | null | undefined,
  snapshot: unknown,
): SubscriptionBillingCycle {
  if (checkoutBillingCycle === 'monthly' || checkoutBillingCycle === 'yearly') {
    return checkoutBillingCycle;
  }
  const snapshotCycle =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as { billingCycle?: unknown }).billingCycle
      : undefined;
  if (snapshotCycle === 'monthly' || snapshotCycle === 'yearly') return snapshotCycle;
  return 'monthly';
}

/** The plan's configured gift for one cycle, or null for "none" (NULL, 0, or out of range). */
export function giftedDaysForCycle(
  plan: {
    readonly giftedDaysMonthly: number | null;
    readonly giftedDaysYearly: number | null;
  },
  billingCycle: SubscriptionBillingCycle,
): number | null {
  const value =
    billingCycle === 'yearly' ? plan.giftedDaysYearly : plan.giftedDaysMonthly;
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 5 || value > 15) return null;
  return value;
}

export interface PurchaseDates {
  readonly gift: {
    readonly days: number;
    readonly startsAt: Date;
    readonly endsAt: Date;
  } | null;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
}

/**
 * The dates one approved plan purchase produces.
 *
 *   - With a gift: `[approvedAt, approvedAt + N days)` is the gifted segment
 *     and the paid period runs from the gift's end for one full cycle, so the
 *     customer receives exactly the period they paid for, plus N days.
 *   - Without: the paid period starts at `periodStart` (now, or the current
 *     period end for an early renewal).
 */
export function computePurchaseDates(input: {
  readonly periodStart: Date;
  readonly billingCycle: SubscriptionBillingCycle;
  readonly giftedDays: number | null;
}): PurchaseDates {
  if (input.giftedDays) {
    const startsAt = input.periodStart;
    const endsAt = addDaysUtc(startsAt, input.giftedDays);
    return {
      gift: { days: input.giftedDays, startsAt, endsAt },
      currentPeriodStart: endsAt,
      currentPeriodEnd: addBillingPeriod(endsAt, input.billingCycle),
    };
  }
  return {
    gift: null,
    currentPeriodStart: input.periodStart,
    currentPeriodEnd: addBillingPeriod(input.periodStart, input.billingCycle),
  };
}
