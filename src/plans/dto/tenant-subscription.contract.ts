/**
 * `TenantSubscription` response contract — matches `TenantSubscription`
 * (`tenant.types.ts`) field-for-field, embedding the full `Plan` (not just
 * `planId`) exactly as the frontend type requires.
 */
import type {
  Plan as PrismaPlan,
  TenantSubscription as PrismaTenantSubscription,
} from '@prisma/client';
import { toPlanResponse, withoutPlanPricing } from './plan.contract';
import type { PlanResponse } from './plan.contract';
import { readPriceChangeNotice } from '../utils/price-change-notice.util';
import type { NoticeLimitChange, NoticePrice } from '../utils/price-change-notice.util';

export interface TenantSubscriptionResponse {
  readonly organizationId: string;
  readonly status: PrismaTenantSubscription['status'];
  readonly planId: string;
  readonly plan: PlanResponse;
  readonly trialEndsAt?: string;
  readonly graceEndsAt?: string;
  readonly currentPeriodStart?: string;
  readonly currentPeriodEnd?: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly billingCycle?: PrismaTenantSubscription['billingCycle'];
  /**
   * W8 — gifted setup days granted on this organization's first paid
   * subscription. Present only when a gift was granted. The paid period
   * (`currentPeriodStart`) begins at `giftedEndsAt`, so during the gift
   * `currentPeriodStart` is in the FUTURE — render it as "paid period
   * starts", never as "started".
   */
  readonly giftedDays?: number;
  readonly giftedStartsAt?: string;
  readonly giftedEndsAt?: string;
  /**
   * B0-BIL-04 — a smaller plan already bought and paid for that takes over
   * at `effectiveAt` (the end of the current paid period). Until then the
   * current plan and its limits apply.
   */
  readonly scheduledChange?: {
    readonly planId: string;
    readonly planName: string;
    readonly effectiveAt: string;
  };
  /**
   * B0-BIL-07 — the plan this organization renews into had its price or
   * limits edited. Present until the next paid renewal or until the owner
   * dismisses it. `effectiveAt` is the end of the current paid period, and
   * is absent in grace (the next renewal is whenever they pay).
   */
  readonly priceChangeNotice?: {
    readonly planId: string;
    readonly planName: string;
    readonly billingCycle: 'monthly' | 'yearly';
    readonly fromPrice: NoticePrice | null;
    readonly toPrice: NoticePrice | null;
    readonly limitChanges: Readonly<Record<string, NoticeLimitChange>>;
    readonly noticedAt: string;
    readonly effectiveAt?: string;
  };
  /**
   * B2 — present while this organization is a Founding Academy (its seat is
   * held: active, or ended with the lock over). Billing owners only — the
   * member view drops it with every other price.
   */
  readonly founding?: TenantFoundingResponse;
}

export interface TenantFoundingResponse {
  readonly status: 'active' | 'ended';
  readonly seatNumber: number;
  readonly planId: string;
  readonly lockedPrice: { readonly amount: number; readonly currency: string };
  readonly lockStartsAt: string;
  readonly lockEndsAt: string;
  /**
   * What the next yearly renewal of the locked plan would be charged — the
   * same server rule checkout applies. `locked: false` once the renewal
   * falls after the lock end (catalog price).
   */
  readonly nextRenewal?: {
    readonly amount: number;
    readonly currency: string;
    readonly locked: boolean;
    readonly periodStartsAt: string;
  };
}

function describePriceChangeNotice(
  subscription: PrismaTenantSubscription & { plan: PrismaPlan },
  scheduledPlanName: string | undefined,
): Pick<TenantSubscriptionResponse, 'priceChangeNotice'> {
  const notice = readPriceChangeNotice(subscription.priceChangeNotice);
  if (!notice || subscription.priceChangeNoticeDismissedAt) return {};
  if (subscription.status !== 'active' && subscription.status !== 'grace_period')
    return {};
  // Only a notice about the plan this organization actually renews into.
  const nextPlanId = subscription.scheduledPlanId ?? subscription.planId;
  if (notice.planId !== nextPlanId) return {};
  const planName = subscription.scheduledPlanId
    ? scheduledPlanName
    : subscription.plan.name;
  return {
    priceChangeNotice: {
      planId: notice.planId,
      planName: planName ?? '',
      billingCycle: notice.billingCycle,
      fromPrice: notice.fromPrice,
      toPrice: notice.toPrice,
      limitChanges: notice.limitChanges ?? {},
      noticedAt: notice.noticedAt,
      ...(subscription.status === 'active' && subscription.currentPeriodEnd
        ? { effectiveAt: subscription.currentPeriodEnd.toISOString() }
        : {}),
    },
  };
}

/**
 * SEC-03(b) — the subscription as a member who is NOT the billing owner
 * sees it.
 *
 * Kept readable by every member on purpose: the dashboard, plan gating and
 * the storage meter of managers, instructors and staff depend on the plan,
 * its limits and features, the status and the dates. What is removed is
 * only what the organization PAYS: the plan's `pricing`, and the
 * `priceChangeNotice` (old and new price), which is addressed to the owner
 * and dismissible only by them. `billingCycle`, gift and scheduled-change
 * facts carry no amount and stay.
 */
export function toMemberSubscriptionView(
  subscription: TenantSubscriptionResponse,
): TenantSubscriptionResponse {
  return {
    ...subscription,
    plan: withoutPlanPricing(subscription.plan),
    priceChangeNotice: undefined,
    founding: undefined,
  };
}

export function toTenantSubscriptionResponse(
  subscription: PrismaTenantSubscription & { plan: PrismaPlan },
  defaultTrialDurationDays?: number,
  scheduledPlanName?: string,
): TenantSubscriptionResponse {
  return {
    organizationId: subscription.organizationId,
    status: subscription.status,
    planId: subscription.planId,
    plan: toPlanResponse(subscription.plan, defaultTrialDurationDays),
    trialEndsAt: subscription.trialEndsAt?.toISOString(),
    graceEndsAt: subscription.graceEndsAt?.toISOString(),
    currentPeriodStart: subscription.currentPeriodStart?.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    billingCycle: subscription.billingCycle ?? undefined,
    ...(subscription.giftedDays &&
    subscription.giftedStartsAt &&
    subscription.giftedEndsAt
      ? {
          giftedDays: subscription.giftedDays,
          giftedStartsAt: subscription.giftedStartsAt.toISOString(),
          giftedEndsAt: subscription.giftedEndsAt.toISOString(),
        }
      : {}),
    ...(subscription.scheduledPlanId &&
    subscription.scheduledChangeAt &&
    scheduledPlanName
      ? {
          scheduledChange: {
            planId: subscription.scheduledPlanId,
            planName: scheduledPlanName,
            effectiveAt: subscription.scheduledChangeAt.toISOString(),
          },
        }
      : {}),
    ...describePriceChangeNotice(subscription, scheduledPlanName),
  };
}
