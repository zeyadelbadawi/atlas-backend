/**
 * `AtlasSubscriptionPaymentProviderConfig` response contract (Atlas
 * Subscription Payment — Generic Payment Gateway Integration Readiness,
 * 2026-08-26). NEVER carries `encryptedConfig` or any decrypted
 * equivalent — this type has no field capable of holding one, matching
 * `OrganizationGatewayCredentialResponse`'s identical discipline.
 *
 * `effectiveProviderKey`/`effectiveProviderDisplayName` surface WHICH
 * adapter Atlas Subscription Payments are actually running on right now —
 * `'atlas_manual'` when nothing has been explicitly configured (today's
 * real default, resolved by `AtlasSubscriptionPaymentProviderService`,
 * never a second hardcoded default anywhere else in this response).
 */
import type { AtlasSubscriptionPaymentProviderConfigSummary } from '../repositories/atlas-subscription-payment-provider-config.repository';

export interface AtlasSubscriptionPaymentProviderConfigResponse {
  readonly providerKey: string | null;
  readonly status: 'not_configured' | 'configured' | 'verified' | 'disabled';
  readonly enabled: boolean;
  readonly lastTestedAt?: string;
  readonly lastTestResult?: { readonly success: boolean; readonly message?: string };
  readonly updatedAt?: string;
  readonly effectiveProviderKey: string;
  readonly effectiveProviderDisplayName: string;
}

export function toAtlasSubscriptionPaymentProviderConfigResponse(
  config: AtlasSubscriptionPaymentProviderConfigSummary,
  effectiveProviderKey: string,
  effectiveProviderDisplayName: string,
): AtlasSubscriptionPaymentProviderConfigResponse {
  return {
    providerKey: config.providerKey,
    status: config.status,
    enabled: config.enabled,
    lastTestedAt: config.lastTestedAt?.toISOString(),
    lastTestResult: config.lastTestResult as unknown as
      { readonly success: boolean; readonly message?: string } | undefined,
    updatedAt: config.updatedAt.toISOString(),
    effectiveProviderKey,
    effectiveProviderDisplayName,
  };
}

export interface AvailableAtlasSubscriptionPaymentProviderResponse {
  readonly providerKey: string;
  readonly displayName: string;
}
