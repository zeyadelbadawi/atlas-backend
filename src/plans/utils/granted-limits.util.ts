/**
 * Resolving a subscription's effective limits (P61).
 *
 * THE ONE RULE: `granted_limits ?? plan.limits`. Every place that turns a
 * subscription into numbers goes through this function, so "what is this
 * customer entitled to" has exactly one answer — the write gate, the Usage
 * page, the recording quota and the add-on access check cannot drift into
 * telling a customer three different numbers.
 *
 * WHY A FUNCTION AND NOT A SECOND SERVICE. This is not entitlement
 * CALCULATION — `EntitlementService.computeEffectiveEntitlements` remains
 * the only thing that combines a plan with add-ons, and it is unchanged.
 * This decides only which limit SET to hand it: the one the customer was
 * granted, or (when none was recorded) the catalog's current one.
 *
 * WHY THE FALLBACK IS NOT A MIGRATION CONCERN. A subscription created
 * before P61 has no recorded grant, and nothing in the database says what
 * the catalog held when it was bought — so NULL means "follow the catalog",
 * which is precisely how that row already behaved. New grants are captured
 * at the two points that grant them, so the column fills in correctly going
 * forward without anyone inventing history.
 *
 * FEATURES ARE NOT SNAPSHOTTED, deliberately. P61 is about purchased
 * CAPACITY. A feature flag is a product capability the platform ships or
 * withdraws, not a quantity the customer bought a specific amount of, and
 * freezing features would strand tenants on removed implementations.
 */
import type { Plan, TenantSubscription } from '@prisma/client';
import type { PlanResourceLimits } from '../dto/entitlement.types';

/** The shape every entitlement read already has to hand. */
export type SubscriptionWithPlan = Pick<TenantSubscription, 'grantedLimits'> & {
  readonly plan: Pick<Plan, 'limits'>;
};

/**
 * The limits this subscription is actually entitled to.
 *
 * A recorded grant wins over the catalog, always — that is the entire
 * point. The catalog is only consulted when no grant was recorded.
 */
export function resolveSubscriptionLimits(
  subscription: SubscriptionWithPlan,
): PlanResourceLimits {
  const granted = subscription.grantedLimits;

  // `Json?` is `JsonValue | null`, which includes arrays, strings and
  // numbers — none of which is a limit set. Anything that is not a plain
  // object falls back rather than being coerced into a nonsense limit.
  if (granted !== null && typeof granted === 'object' && !Array.isArray(granted)) {
    return granted as unknown as PlanResourceLimits;
  }

  return subscription.plan.limits as unknown as PlanResourceLimits;
}

/**
 * The value to WRITE when an entitlement is granted — a plan's current
 * limits, frozen. Used by the paid-activation and trial-start paths, in the
 * same statement that sets `planId`, so the two can never disagree about
 * what was granted.
 */
export function limitsToGrant(plan: Pick<Plan, 'limits'>): PlanResourceLimits {
  return plan.limits as unknown as PlanResourceLimits;
}
