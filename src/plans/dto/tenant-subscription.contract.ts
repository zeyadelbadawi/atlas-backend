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
}

export function toTenantSubscriptionResponse(
  subscription: PrismaTenantSubscription & { plan: PrismaPlan },
): TenantSubscriptionResponse {
  return {
    organizationId: subscription.organizationId,
    status: subscription.status,
    planId: subscription.planId,
    plan: toPlanResponse(subscription.plan),
    trialEndsAt: subscription.trialEndsAt?.toISOString(),
    graceEndsAt: subscription.graceEndsAt?.toISOString(),
    currentPeriodStart: subscription.currentPeriodStart?.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    billingCycle: subscription.billingCycle ?? undefined,
  };
}
