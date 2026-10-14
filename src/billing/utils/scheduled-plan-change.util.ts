/**
 * B0-BIL-04 — when a plan bought during a paid period is a DOWNGRADE that
 * must wait for the end of that period.
 *
 * A purchase while a paid period is running already starts its own period
 * at the current period's end (`PaymentApplicationService`), but the plan
 * and its limits used to switch at approval. For an upgrade that is what
 * the customer wants. For a downgrade it took away capacity the customer
 * had already paid for. Now a downgrade with more than
 * `SCHEDULED_CHANGE_MIN_DAYS_LEFT` days left is scheduled for the period
 * end; closer to the end it applies at once, as before.
 */
import type { LimitValue, PlanResourceLimits } from '../../plans/dto/entitlement.types';

export const SCHEDULED_CHANGE_MIN_DAYS_LEFT = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function asNumber(value: LimitValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value === 'unlimited' ? Number.POSITIVE_INFINITY : value;
}

/** Whether `next` grants less than `current` on any limit both define. */
export function isLimitDowngrade(
  current: PlanResourceLimits,
  next: PlanResourceLimits,
): boolean {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    const before = asNumber((current as unknown as Record<string, LimitValue>)[key]);
    const after = asNumber((next as unknown as Record<string, LimitValue>)[key]);
    if (before === undefined || after === undefined) continue;
    if (after < before) return true;
  }
  return false;
}

/** Whether a downgrade bought now must wait for `currentPeriodEnd`. */
export function shouldScheduleDowngrade(input: {
  readonly currentPlanId: string;
  readonly nextPlanId: string;
  readonly currentLimits: PlanResourceLimits;
  readonly nextLimits: PlanResourceLimits;
  readonly currentPeriodEnd: Date;
  readonly now: Date;
}): boolean {
  if (input.currentPlanId === input.nextPlanId) return false;
  const msLeft = input.currentPeriodEnd.getTime() - input.now.getTime();
  if (msLeft <= SCHEDULED_CHANGE_MIN_DAYS_LEFT * DAY_MS) return false;
  return isLimitDowngrade(input.currentLimits, input.nextLimits);
}
