/**
 * B0-BIL-07 — what a catalog edit changes for ONE existing subscriber.
 *
 * Renewal is a new checkout priced from the live plan row, and it re-grants
 * the plan's current limits. So a Platform Owner's edit to a plan's price
 * or limits reaches every paying customer on that plan at their next
 * renewal, and Terms §9 promises them notice in the product before it
 * does. This file decides, per subscriber, whether there is anything to
 * tell them and what: the renewal price for THEIR billing cycle before and
 * after, and every limit that will differ from what they hold now.
 *
 * Pure: no database, no clock. The caller passes `noticedAt`.
 */
import type { LimitValue } from '../dto/entitlement.types';

export interface NoticePrice {
  readonly amount: number;
  readonly currency: string;
}

export interface NoticeLimitChange {
  readonly from: LimitValue | null;
  readonly to: LimitValue | null;
}

/** Stored in `tenant_subscriptions.price_change_notice`. */
export interface PriceChangeNotice {
  readonly planId: string;
  /** The plan `version` the notice describes — part of the email dedupe key. */
  readonly planVersion: number;
  readonly billingCycle: 'monthly' | 'yearly';
  /** `null` when the plan had no price for this cycle. */
  readonly fromPrice: NoticePrice | null;
  readonly toPrice: NoticePrice | null;
  readonly limitChanges: Readonly<Record<string, NoticeLimitChange>>;
  readonly noticedAt: string;
}

type Cycle = 'monthly' | 'yearly';

interface PricingShape {
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly billingCycle?: unknown;
  readonly yearlyAmount?: unknown;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The price a renewal on `cycle` would be charged, by the same rules as
 * `CheckoutService.resolvePricingOrThrow` — but `null` instead of an
 * error when the plan has no price for that cycle.
 */
export function renewalPriceFor(pricing: unknown, cycle: Cycle): NoticePrice | null {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return null;
  const parsed = pricing as PricingShape;
  if (typeof parsed.currency !== 'string' || parsed.currency === '') return null;

  if (
    cycle === 'yearly' &&
    parsed.billingCycle === 'monthly' &&
    isAmount(parsed.yearlyAmount)
  ) {
    return { amount: parsed.yearlyAmount, currency: parsed.currency };
  }
  if (!isAmount(parsed.amount)) return null;
  if (typeof parsed.billingCycle === 'string' && parsed.billingCycle !== cycle)
    return null;
  return { amount: parsed.amount, currency: parsed.currency };
}

/** The cycle a subscriber renews on: theirs, else the plan's own, else monthly. */
export function renewalCycleFor(
  subscriptionCycle: Cycle | null | undefined,
  pricing: unknown,
): Cycle {
  if (subscriptionCycle) return subscriptionCycle;
  const planCycle = (pricing as PricingShape | null)?.billingCycle;
  return planCycle === 'yearly' ? 'yearly' : 'monthly';
}

function samePrice(a: NoticePrice | null, b: NoticePrice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.amount === b.amount && a.currency === b.currency;
}

function limitValue(limits: unknown, key: string): LimitValue | null {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null;
  const value = (limits as Record<string, unknown>)[key];
  if (value === 'unlimited') return 'unlimited';
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function limitKeys(...sets: unknown[]): string[] {
  const keys = new Set<string>();
  for (const set of sets) {
    if (set && typeof set === 'object' && !Array.isArray(set)) {
      for (const key of Object.keys(set)) keys.add(key);
    }
  }
  return [...keys].sort();
}

/** Narrows a stored JSON value to a notice, or `null` for anything else. */
export function readPriceChangeNotice(value: unknown): PriceChangeNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const notice = value as Partial<PriceChangeNotice>;
  if (typeof notice.planId !== 'string' || typeof notice.noticedAt !== 'string')
    return null;
  return notice as PriceChangeNotice;
}

export interface BuildPriceChangeNoticeInput {
  readonly planId: string;
  readonly planVersion: number;
  readonly billingCycle: Cycle;
  readonly previousPricing: unknown;
  readonly nextPricing: unknown;
  /** What the subscriber holds now (granted limits, else the old plan row). */
  readonly currentLimits: unknown;
  readonly nextLimits: unknown;
  /** A notice already on the row and not yet acted on by a renewal. */
  readonly pending: PriceChangeNotice | null;
  readonly noticedAt: Date;
}

/**
 * The notice this subscriber is owed, or `null` when their next renewal is
 * unchanged by the edit.
 *
 * When a notice is already pending for the same plan, its `fromPrice` is
 * kept: the customer has not renewed since, so the price they last saw
 * quoted is still the first one, and two edits in a row must not make the
 * banner say "from 1,300 to 1,190" when they were told 1,190 → 1,300 and
 * have only ever paid 1,190. If the second edit puts everything back, the
 * result is `null` and the caller clears the notice.
 */
export function buildPriceChangeNotice(
  input: BuildPriceChangeNoticeInput,
): PriceChangeNotice | null {
  const carried =
    input.pending && input.pending.planId === input.planId ? input.pending : null;
  const fromPrice =
    carried && carried.billingCycle === input.billingCycle
      ? carried.fromPrice
      : renewalPriceFor(input.previousPricing, input.billingCycle);
  const toPrice = renewalPriceFor(input.nextPricing, input.billingCycle);

  const limitChanges: Record<string, NoticeLimitChange> = {};
  for (const key of limitKeys(input.currentLimits, input.nextLimits)) {
    const from = limitValue(input.currentLimits, key);
    const to = limitValue(input.nextLimits, key);
    if (from !== to) limitChanges[key] = { from, to };
  }

  if (samePrice(fromPrice, toPrice) && Object.keys(limitChanges).length === 0) {
    return null;
  }
  return {
    planId: input.planId,
    planVersion: input.planVersion,
    billingCycle: input.billingCycle,
    fromPrice,
    toPrice,
    limitChanges,
    noticedAt: input.noticedAt.toISOString(),
  };
}

/** `1,190 EGP` — the same in both email locales. */
export function formatNoticePrice(price: NoticePrice | null): string {
  if (!price) return '';
  return `${price.amount.toLocaleString('en-US')} ${price.currency}`;
}
