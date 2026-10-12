/**
 * CF-24 / B0-BIL-03 — a self-serve plan CHANGE is refused while an annual
 * period still has more than 30 days to run.
 *
 * WHY. A plan purchase made while a subscription is active (or in grace)
 * re-grants the NEW plan's limits at approval, while its period starts at
 * the old period end (`PaymentApplicationService`: `periodStart =
 * existing.currentPeriodEnd`). An annual customer with eleven months left
 * who bought one month of a bigger plan therefore received the bigger
 * plan's limits for those eleven months plus one, for one month's price.
 * Until proration exists, a mid-annual change goes through Atlas support.
 *
 * Renewing the SAME plan is always allowed, and so is any change in the
 * last 30 days of an annual period (the new period then starts close to
 * when the limits change) or on a monthly subscription.
 */
export const ANNUAL_CHANGE_WINDOW_DAYS = 30;

export interface CurrentSubscriptionForChange {
  readonly status: string;
  readonly billingCycle: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly planKey: string;
}

export function isRefusedMidAnnualPlanChange(
  current: CurrentSubscriptionForChange | null,
  targetPlanKey: string,
  now: Date,
): boolean {
  if (!current) return false;
  if (current.planKey === targetPlanKey) return false;
  if (current.status !== 'active' && current.status !== 'grace_period') return false;
  if (current.billingCycle !== 'yearly' || !current.currentPeriodEnd) return false;
  const remainingMs = current.currentPeriodEnd.getTime() - now.getTime();
  return remainingMs > ANNUAL_CHANGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
