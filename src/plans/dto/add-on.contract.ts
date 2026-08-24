/**
 * `AddOn` response contract — matches `AddOn` (`plan.types.ts`)
 * field-for-field. See `plan.contract.ts`'s doc comment for the same
 * "no write endpoint in P4" note.
 */
import type { AddOn as PrismaAddOn } from '@prisma/client';
import type { AddOnEffect } from './entitlement.types';
import type { PlanPricingMetadataResponse } from './plan.contract';

export interface AddOnResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly effect: AddOnEffect;
  readonly compatiblePlanKeys: readonly string[];
  readonly pricing?: PlanPricingMetadataResponse;
}

export function toAddOnResponse(addOn: PrismaAddOn): AddOnResponse {
  return {
    id: addOn.id,
    key: addOn.key,
    name: addOn.name,
    description: addOn.description ?? undefined,
    effect: addOn.effect as unknown as AddOnEffect,
    compatiblePlanKeys: addOn.compatiblePlanKeys,
    pricing: (addOn.pricing as PlanPricingMetadataResponse | null) ?? undefined,
  };
}
