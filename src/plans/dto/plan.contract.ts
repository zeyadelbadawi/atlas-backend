/**
 * `Plan` response contract — matches `Plan` (`plan.types.ts`) field-for-
 * field. `limits`/`features`/`pricing` are stored as JSONB and validated
 * server-side at write time (there is no write endpoint for `plans` in
 * P4 — the catalog is seeded directly, mirroring how P2 seeds test
 * organizations — so today validation matters only for internal
 * consistency, not an inbound request), never schema-enforced, matching
 * `users.preferences`'s established precedent in this codebase.
 */
import type { Plan as PrismaPlan } from '@prisma/client';
import type { PlanFeatures, PlanResourceLimits } from './entitlement.types';

export interface PlanPricingMetadataResponse {
  readonly amount?: number;
  readonly currency?: string;
  readonly billingCycle?: 'monthly' | 'yearly';
}

export interface PlanResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly status: PrismaPlan['status'];
  readonly displayOrder: number;
  readonly limits: PlanResourceLimits;
  readonly features: PlanFeatures;
  readonly pricing?: PlanPricingMetadataResponse;
  /**
   * Phase 11 — whether this plan may be taken as a Free Trial.
   *
   * FOR DISPLAY ONLY. The frontend uses it to decide whether to render a
   * "Try free" CTA instead of "Select this plan"; it is never the control.
   * `TrialRedemptionService.startTrial` re-reads the same column and
   * refuses regardless of what any client believed.
   */
  readonly trialEligible: boolean;
  /** Days this plan's trial runs, resolved against the platform default. Absent when the plan is not trialable. */
  readonly trialDurationDays?: number;
}

export function toPlanResponse(
  plan: PrismaPlan,
  /**
   * The platform-wide default, used when a plan does not override it.
   * Passed in rather than read here so this stays a pure mapper, and so
   * the caller makes exactly one policy read for a whole catalog page
   * instead of one per plan.
   */
  defaultTrialDurationDays?: number,
): PlanResponse {
  const trialDurationDays = plan.trialEligible
    ? (plan.trialDurationDays ?? defaultTrialDurationDays)
    : undefined;

  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description ?? undefined,
    status: plan.status,
    displayOrder: plan.displayOrder,
    limits: plan.limits as unknown as PlanResourceLimits,
    features: plan.features as unknown as PlanFeatures,
    pricing: (plan.pricing as PlanPricingMetadataResponse | null) ?? undefined,
    trialEligible: plan.trialEligible,
    ...(trialDurationDays === undefined ? {} : { trialDurationDays }),
  };
}
