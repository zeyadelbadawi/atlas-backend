/**
 * `TenantAddOn` response contract — matches `TenantAddOn` (`tenant.types.ts`)
 * field-for-field, embedding the full `AddOn` exactly as the frontend type
 * requires.
 */
import type {
  AddOn as PrismaAddOn,
  TenantAddOn as PrismaTenantAddOn,
} from '@prisma/client';
import { toAddOnResponse, withoutAddOnPricing } from './add-on.contract';
import type { AddOnResponse } from './add-on.contract';

export interface TenantAddOnResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly addOnId: string;
  readonly addOn: AddOnResponse;
  readonly activatedAt: string;
}

/** SEC-03(b) — the member view: which add-ons are active (and what they grant), never what they cost. */
export function toMemberTenantAddOnView(
  tenantAddOn: TenantAddOnResponse,
): TenantAddOnResponse {
  return { ...tenantAddOn, addOn: withoutAddOnPricing(tenantAddOn.addOn) };
}

export function toTenantAddOnResponse(
  tenantAddOn: PrismaTenantAddOn & { addOn: PrismaAddOn },
): TenantAddOnResponse {
  return {
    id: tenantAddOn.id,
    organizationId: tenantAddOn.organizationId,
    addOnId: tenantAddOn.addOnId,
    addOn: toAddOnResponse(tenantAddOn.addOn),
    activatedAt: tenantAddOn.activatedAt.toISOString(),
  };
}
