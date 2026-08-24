/**
 * `TenantAddOn` response contract — matches `TenantAddOn` (`tenant.types.ts`)
 * field-for-field, embedding the full `AddOn` exactly as the frontend type
 * requires.
 */
import type {
  AddOn as PrismaAddOn,
  TenantAddOn as PrismaTenantAddOn,
} from '@prisma/client';
import { toAddOnResponse } from './add-on.contract';
import type { AddOnResponse } from './add-on.contract';

export interface TenantAddOnResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly addOnId: string;
  readonly addOn: AddOnResponse;
  readonly activatedAt: string;
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
