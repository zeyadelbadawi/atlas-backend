/**
 * `OrganizationPaymentSettings` response contract (master plan §4.1/§5.8).
 * No frontend contract exists for this yet — this feature is backend-only
 * in this phase — so this DTO follows this codebase's own established
 * shape conventions (flat, `camelCase`, ISO date strings) rather than
 * mirroring an existing frontend type file.
 */
import type { OrganizationPaymentSettings, PaymentCollectionMode } from '@prisma/client';

export interface OrganizationPaymentSettingsResponse {
  readonly organizationId: string;
  readonly paymentCollectionMode: PaymentCollectionMode;
  readonly updatedAt?: string;
}

/** `settings` is `null` when the Organization has never touched this setting — resolves to the real `unconfigured` default (§4.1), never a silent alternative mode. */
export function toOrganizationPaymentSettingsResponse(
  organizationId: string,
  settings: OrganizationPaymentSettings | null,
): OrganizationPaymentSettingsResponse {
  return {
    organizationId,
    paymentCollectionMode: settings?.paymentCollectionMode ?? 'unconfigured',
    updatedAt: settings?.updatedAt.toISOString(),
  };
}
