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
}

export function toPlanResponse(plan: PrismaPlan): PlanResponse {
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
  };
}
