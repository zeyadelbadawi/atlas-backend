/**
 * B2 — Founding Academies: the price lock, decided on the server only.
 *
 * A founding membership locks ONE plan's annual catalog price for 24
 * months. Whether a purchase gets that price is decided here, from the
 * organization's own membership row read inside the checkout transaction —
 * never from anything the client sends. There are no founding plan keys,
 * IDs or prices a client could submit: a member and a non-member send the
 * same request (`{ planKey: 'growth', billingCycle: 'yearly' }`), and only
 * the member's row changes the frozen checkout price. A non-member
 * therefore cannot obtain the founding price, and nothing in the API
 * reveals that the programme or another organization's membership exists.
 *
 * The rule (pure, unit-tested):
 *   - the membership is `active` (a revoked or ended one never applies);
 *   - the purchase is the membership's plan, on the yearly cycle;
 *   - the paid period it buys STARTS before `lockEndsAt` (a renewal is a
 *     new period starting at the current period end; see
 *     `expectedPurchasePeriodStart`, the twin of `PaymentApplicationService`).
 * So the period starting at the lock start and the one renewal starting a
 * year later are at the locked price; the renewal starting at or after the
 * 24-month mark returns to the live catalog. Revoking ends the lock at the
 * next renewal: the current paid period was already paid and is untouched.
 */
import type { Prisma, SubscriptionBillingCycle } from '@prisma/client';
import { addCalendarMonthsUtc } from '../billing/utils/billing-period.util';
import { renewalPriceFor } from '../plans/utils/price-change-notice.util';

export const FOUNDING_SEAT_CAP = 20;
export const FOUNDING_LOCK_MONTHS = 24;
/** Labour-bound onboarding pace shown to Platform Owners (not enforced). */
export const FOUNDING_WEEKLY_ONBOARDING_TARGET = 5;
/** Concierge setup hours included; shown, not enforced. */
export const FOUNDING_CONCIERGE_HOURS_CAP = 6;

export interface FoundingLock {
  readonly id: string;
  readonly seatNumber: number;
  readonly planId: string;
  readonly lockedAmount: number;
  readonly lockedCurrency: string;
  readonly lockStartsAt: Date;
  readonly lockEndsAt: Date;
  readonly status: 'active' | 'revoked' | 'ended';
}

export interface FoundingPrice {
  readonly amount: number;
  readonly currency: string;
}

export function lockEndFor(lockStartsAt: Date): Date {
  return addCalendarMonthsUtc(lockStartsAt, FOUNDING_LOCK_MONTHS);
}

/**
 * When the period a purchase made at `now` would start: the end of a live
 * paid period (a renewal extends it), else now. Same rule as
 * `PaymentApplicationService` (`extendsCurrentPeriod`).
 */
export function expectedPurchasePeriodStart(
  subscription: {
    readonly status: string;
    readonly currentPeriodEnd: Date | null;
  } | null,
  now: Date,
): Date {
  if (
    subscription &&
    (subscription.status === 'active' || subscription.status === 'grace_period') &&
    subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd.getTime() > now.getTime()
  ) {
    return subscription.currentPeriodEnd;
  }
  return now;
}

/** The locked price for this purchase, or `null` for the live catalog price. */
export function foundingPriceFor(
  lock: FoundingLock | null,
  purchase: {
    readonly planId: string;
    readonly billingCycle: SubscriptionBillingCycle | null | undefined;
    readonly periodStart: Date;
  },
): FoundingPrice | null {
  if (!lock || lock.status !== 'active') return null;
  if (purchase.planId !== lock.planId) return null;
  if (purchase.billingCycle !== 'yearly') return null;
  if (purchase.periodStart.getTime() >= lock.lockEndsAt.getTime()) return null;
  return { amount: lock.lockedAmount, currency: lock.lockedCurrency };
}

type FoundingRow = Prisma.FoundingMembershipGetPayload<Record<string, never>>;

export function toFoundingLock(row: FoundingRow): FoundingLock {
  return {
    id: row.id,
    seatNumber: row.seatNumber,
    planId: row.planId,
    lockedAmount: Number(row.lockedAmount),
    lockedCurrency: row.lockedCurrency,
    lockStartsAt: row.lockStartsAt,
    lockEndsAt: row.lockEndsAt,
    status: row.status,
  };
}

/**
 * The organization's membership that holds a seat (active or ended), read
 * in the caller's transaction. In a tenant context RLS returns only that
 * organization's own row.
 */
export async function readFoundingMembership(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<FoundingLock | null> {
  const row = await tx.foundingMembership.findFirst({
    where: { organizationId, status: { not: 'revoked' } },
  });
  return row ? toFoundingLock(row) : null;
}

/**
 * The live catalog's annual price for a plan — exactly what a yearly
 * checkout would charge (`renewalPriceFor`, the twin of
 * `CheckoutService.resolvePricingOrThrow`), or `null` when it has none.
 */
export function catalogAnnualPrice(pricing: unknown): FoundingPrice | null {
  return renewalPriceFor(pricing, 'yearly');
}

export function samePrice(a: FoundingPrice | null, b: FoundingPrice | null): boolean {
  if (!a || !b) return a === b;
  return a.amount === b.amount && a.currency === b.currency;
}
