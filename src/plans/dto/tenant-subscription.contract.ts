/**
 * `TenantSubscription` response contract — matches `TenantSubscription`
 * (`tenant.types.ts`) field-for-field, embedding the full `Plan` (not just
 * `planId`) exactly as the frontend type requires.
 */
import type {
  Plan as PrismaPlan,
  TenantSubscription as PrismaTenantSubscription,
} from '@prisma/client';
import { toPlanResponse } from './plan.contract';
import type { PlanResponse } from './plan.contract';

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
}

export function toTenantSubscriptionResponse(
  subscription: PrismaTenantSubscription & { plan: PrismaPlan },
  defaultTrialDurationDays?: number,
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
  };
}
