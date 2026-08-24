/**
 * EntitlementService — server-side port of `entitlement.utils.ts` (atlas
 * frontend `src/features/tenant/utils/entitlement.utils.ts`). Every
 * function here is a direct, deliberate mirror of its frontend
 * counterpart — same name, same signature shape, same behavior — so the
 * two can never silently drift (master plan §21 Phase P4: "mirrors
 * `getLimitGapAction`/`getFeatureGapAction`").
 *
 * Pure computation, no I/O — takes already-fetched Plan/AddOn/usage data
 * and returns a derived result, exactly like the frontend version. Used
 * internally by `TenantSubscriptionService` to compute the `limit`
 * embedded in each `UsageMetric` of a `GET .../usage` response; not itself
 * exposed as an HTTP endpoint (there is no such endpoint in the frontend's
 * `TenantService`/`PlanService` contract — "do not invent a new
 * entitlement model" extends to not inventing a new endpoint for it).
 */
import { Injectable } from '@nestjs/common';
import type {
  EffectiveEntitlements,
  EntitlementAddOnInput,
  EntitlementGapAction,
  EntitlementPlanInput,
  LimitValue,
  PlanFeatureKey,
  PlanFeatures,
  PlanLimitKey,
  PlanResourceLimits,
  ResourceLimitStatus,
} from '../dto/entitlement.types';

/** Adds a limit amount on top of a base value. `'unlimited'` absorbs any addition — mirrors `addToLimit` (frontend, private to that module; re-exposed here as a private method for the identical reason). */
function addToLimit(base: LimitValue, amount: number): LimitValue {
  return base === 'unlimited' ? 'unlimited' : base + amount;
}

@Injectable()
export class EntitlementService {
  /**
   * Combines a Plan's entitlements with a Tenant's active Add-ons into the
   * single effective result — mirrors `computeEffectiveEntitlements`
   * exactly. This is the ONLY place in the backend that performs this
   * calculation, matching the frontend's own "the ONLY place" rule.
   */
  computeEffectiveEntitlements(
    organizationId: string,
    plan: EntitlementPlanInput,
    activeAddOns: readonly EntitlementAddOnInput[],
  ): EffectiveEntitlements {
    const limits: Record<PlanLimitKey, LimitValue> = { ...plan.limits };
    const features: Record<PlanFeatureKey, boolean> = { ...plan.features };

    for (const addOn of activeAddOns) {
      if (addOn.effect.type === 'limit') {
        const { limitKey, amount } = addOn.effect;
        limits[limitKey] = addToLimit(limits[limitKey], amount);
      } else {
        features[addOn.effect.featureKey] = true;
      }
    }

    return {
      organizationId,
      limits: limits as PlanResourceLimits,
      features: features as PlanFeatures,
    };
  }

  /** Mirrors `hasFeature` exactly. */
  hasFeature(
    entitlements: Pick<EffectiveEntitlements, 'features'>,
    featureKey: PlanFeatureKey,
  ): boolean {
    return entitlements.features[featureKey];
  }

  /**
   * Evaluates one resource limit against current usage — mirrors
   * `getResourceLimitStatus` exactly: never divides by zero, never treats
   * `'unlimited'` as a number, returns `'unknown'` instead of guessing
   * when either side is missing.
   */
  getResourceLimitStatus(
    used: number | undefined,
    limit: LimitValue | undefined,
  ): ResourceLimitStatus {
    if (limit === undefined || used === undefined) return 'unknown';
    if (limit === 'unlimited') return 'unlimited';
    return used >= limit ? 'limitReached' : 'allowed';
  }

  /**
   * What closing a reached resource limit would require — mirrors
   * `getLimitGapAction` exactly. This is the ONLY place that decides
   * "upgrade vs. add-on," matching the frontend's own rule.
   */
  getLimitGapAction(
    limitKey: PlanLimitKey,
    status: ResourceLimitStatus,
    currentPlanKey: string,
    addOnCatalog: readonly EntitlementAddOnInput[],
  ): EntitlementGapAction {
    if (status !== 'limitReached') return 'none';

    const coveredByAddOn = addOnCatalog.some(
      (addOn) =>
        addOn.effect.type === 'limit' &&
        addOn.effect.limitKey === limitKey &&
        addOn.compatiblePlanKeys.includes(currentPlanKey),
    );

    return coveredByAddOn ? 'addOn' : 'upgradePlan';
  }

  /** Mirrors `getFeatureGapAction` exactly. */
  getFeatureGapAction(
    featureKey: PlanFeatureKey,
    hasIt: boolean,
    currentPlanKey: string,
    addOnCatalog: readonly EntitlementAddOnInput[],
  ): EntitlementGapAction {
    if (hasIt) return 'none';

    const coveredByAddOn = addOnCatalog.some(
      (addOn) =>
        addOn.effect.type === 'feature' &&
        addOn.effect.featureKey === featureKey &&
        addOn.compatiblePlanKeys.includes(currentPlanKey),
    );

    return coveredByAddOn ? 'addOn' : 'upgradePlan';
  }
}
